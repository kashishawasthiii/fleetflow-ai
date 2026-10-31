import json
import hashlib
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Generator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import Base, SessionLocal, engine
from app.models import (
    AuditLog,
    CODRecord,
    DeliveryProof,
    Driver,
    DriverLocation,
    IntegrationEvent,
    MaintenanceRecord,
    Membership,
    Notification,
    Order,
    OrderEvent,
    OrderSLA,
    Organization,
    TrackingShare,
    User,
)
from app.routing import calculate_road_route, optimize_stops, haversine_km
from app.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


# Address lookup cache and request throttling.
# This public geocoder is for limited, manual prototype testing only;
# use a dedicated provider or self-hosted service for production logistics use.
GEOCODE_CACHE: dict[str, dict] = {}
GEOCODE_LOCK = threading.Lock()
LAST_GEOCODE_REQUEST = 0.0


def geocode_address(address: str) -> dict:
    """Look up one manually submitted Indian address."""
    global LAST_GEOCODE_REQUEST

    address = address.strip()
    if not address:
        raise ValueError("Address cannot be empty.")

    cache_key = address.casefold()
    if cache_key in GEOCODE_CACHE:
        return GEOCODE_CACHE[cache_key]

    with GEOCODE_LOCK:
        if cache_key in GEOCODE_CACHE:
            return GEOCODE_CACHE[cache_key]

        elapsed = time.time() - LAST_GEOCODE_REQUEST
        if elapsed < 1.1:
            time.sleep(1.1 - elapsed)

        params = urlencode({
            "q": address,
            "format": "jsonv2",
            "limit": 1,
            "countrycodes": "in",
        })
        url = "https://nominatim.openstreetmap.org/search?" + params
        request = Request(
            url,
            headers={"User-Agent": "FleetFlowAI/1.0 (student prototype)"},
        )

        try:
            with urlopen(request, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as exc:
            raise RuntimeError(
                "Address lookup service is temporarily unavailable."
            ) from exc
        except json.JSONDecodeError as exc:
            raise RuntimeError("Address lookup returned an invalid response.") from exc
        finally:
            LAST_GEOCODE_REQUEST = time.time()

        if not data:
            raise ValueError(
                f"Could not find coordinates for: {address}. "
                "Please enter a more complete address."
            )

        location = {
            "latitude": float(data[0]["lat"]),
            "longitude": float(data[0]["lon"]),
            "display_name": data[0]["display_name"],
        }
        GEOCODE_CACHE[cache_key] = location
        return location


app = FastAPI(
    title="FleetFlow AI API",
    description="AI-powered delivery and logistics management",
    version="1.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)
ACTIVE_SOCKETS: set[WebSocket] = set()


@app.on_event("startup")
def create_runtime_tables():
    """Create additive runtime tables so a fresh deployment is immediately usable."""
    Base.metadata.create_all(bind=engine)


@app.middleware("http")
async def require_authentication(request: Request, call_next):
    """Protect the operations API while leaving auth and public tracking open."""
    path = request.url.path
    is_public = (
        path in {"/", "/health", "/docs", "/redoc", "/openapi.json"}
        or path.startswith(("/auth/", "/tracking/public/"))
    )
    if request.method == "OPTIONS" or is_public:
        return await call_next(request)

    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Authentication required."},
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        decode_access_token(authorization.removeprefix("Bearer ").strip())
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class AuthRegister(BaseModel):
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=120)


class AuthLogin(BaseModel):
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=1, max_length=128)


def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(token)
    user = db.query(User).filter(User.id == int(payload["sub"]), User.is_active.is_(True)).first()
    if user is None:
        raise HTTPException(status_code=401, detail="User account is inactive or missing.")
    return user


def user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
    }


def record_order_event(db: Session, order_id: int, event_type: str, title: str, detail: str):
    db.add(OrderEvent(
        order_id=order_id,
        event_type=event_type,
        title=title,
        detail=detail,
    ))


def create_notification(
    db: Session,
    title: str,
    message: str,
    severity: str = "info",
    order_id: int | None = None,
    user_id: int | None = None,
    notification_type: str = "operations",
):
    db.add(Notification(
        user_id=user_id,
        order_id=order_id,
        notification_type=notification_type,
        title=title,
        message=message,
        severity=severity,
    ))


def record_audit(
    db: Session,
    user: User | None,
    action: str,
    entity_type: str,
    entity_id: str | None,
    detail: str,
):
    db.add(AuditLog(
        user_id=user.id if user else None,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        detail=detail,
    ))


def get_user_organization(db: Session, user: User) -> Organization | None:
    membership = db.query(Membership).filter(Membership.user_id == user.id).first()
    return db.query(Organization).filter(Organization.id == membership.organization_id).first() if membership else None


def require_roles(user: User, *roles: str):
    if user.role not in roles:
        raise HTTPException(status_code=403, detail="Your role cannot perform this action.")


async def broadcast_event(payload: dict):
    dead = []
    for socket in list(ACTIVE_SOCKETS):
        try:
            await socket.send_json(payload)
        except Exception:
            dead.append(socket)
    for socket in dead:
        ACTIVE_SOCKETS.discard(socket)


@app.post("/auth/register")
def register_account(request: AuthRegister, db: Session = Depends(get_db)):
    email = request.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = User(
        email=email,
        full_name=request.full_name.strip(),
        password_hash=hash_password(request.password),
        role="owner",
    )
    db.add(user)
    db.flush()
    base_slug = re.sub(r"[^a-z0-9]+", "-", request.full_name.strip().lower()).strip("-") or "fleetflow"
    slug = base_slug
    suffix = 2
    while db.query(Organization).filter(Organization.slug == slug).first():
        slug = f"{base_slug}-{suffix}"
        suffix += 1
    organization = Organization(name=f"{request.full_name.strip()}'s Fleet", slug=slug)
    db.add(organization)
    db.flush()
    db.add(Membership(organization_id=organization.id, user_id=user.id, role="owner"))
    record_audit(db, user, "workspace_created", "organization", str(organization.id), "Initial FleetFlow workspace created.")
    db.commit()
    db.refresh(user)
    return {
        "access_token": create_access_token(str(user.id), user.role),
        "token_type": "bearer",
        "user": user_payload(user),
    }


@app.post("/auth/login")
def login_account(request: AuthLogin, db: Session = Depends(get_db)):
    email = request.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if user is None or not verify_password(request.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return {
        "access_token": create_access_token(str(user.id), user.role),
        "token_type": "bearer",
        "user": user_payload(user),
    }


@app.get("/auth/status")
def authentication_status(db: Session = Depends(get_db)):
    """Tell the entry screen whether this deployment has its first account yet."""
    return {"has_accounts": db.query(User.id).first() is not None}


@app.get("/auth/me")
def current_account(user: User = Depends(get_current_user)):
    return user_payload(user)


@app.get("/workspace")
def current_workspace(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    organization = get_user_organization(db, user)
    if organization is None:
        raise HTTPException(status_code=404, detail="No workspace is linked to this account.")
    membership = db.query(Membership).filter(Membership.user_id == user.id, Membership.organization_id == organization.id).first()
    return {"id": organization.id, "name": organization.name, "slug": organization.slug, "role": membership.role if membership else user.role}


# Request schemas
class OrderCreate(BaseModel):
    order_number: str
    customer: str
    pickup: str
    destination: str
    status: str = "Pending"
    priority: str = "Normal"
    eta: str = "Not estimated"
    weight_kg: float = Field(default=1.0, gt=0, le=100000)
    pickup_latitude: float | None = Field(default=None, ge=-90, le=90)
    pickup_longitude: float | None = Field(default=None, ge=-180, le=180)
    destination_latitude: float | None = Field(default=None, ge=-90, le=90)
    destination_longitude: float | None = Field(default=None, ge=-180, le=180)


class GeocodeRequest(BaseModel):
    address: str = Field(min_length=3, max_length=300)


class OrderStatusUpdate(BaseModel):
    status: str


class DriverAssignment(BaseModel):
    driver_id: int | None


class DriverCreate(BaseModel):
    name: str
    vehicle: str
    status: str = "Available"
    deliveries_today: int = Field(default=0, ge=0)
    capacity_kg: float = Field(default=500.0, gt=0, le=100000)
    current_latitude: float | None = Field(default=None, ge=-90, le=90)
    current_longitude: float | None = Field(default=None, ge=-180, le=180)


class DriverLocationUpdate(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    speed_kph: float = Field(default=0, ge=0, le=250)
    source: str = Field(default="driver_app", max_length=30)


class DeliveryProofCreate(BaseModel):
    recipient_name: str = Field(min_length=2, max_length=120)
    signature_name: str | None = Field(default=None, max_length=120)
    photo_url: str | None = Field(default=None, max_length=500)
    otp_verified: bool = False
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    notes: str | None = Field(default=None, max_length=1000)


class SLAUpdate(BaseModel):
    promised_at: datetime | None = None


class CODUpdate(BaseModel):
    amount_due: float = Field(ge=0)
    amount_collected: float = Field(default=0, ge=0)
    reference: str | None = Field(default=None, max_length=120)


class MaintenanceCreate(BaseModel):
    driver_id: int = Field(gt=0)
    service_type: str = Field(min_length=2, max_length=120)
    due_date: datetime | None = None
    odometer_km: float = Field(default=0, ge=0)
    status: str = Field(default="Scheduled", max_length=30)
    notes: str | None = Field(default=None, max_length=1000)


class IntegrationImport(BaseModel):
    provider: str = Field(min_length=2, max_length=60)
    external_id: str = Field(min_length=1, max_length=160)
    orders: list[OrderCreate] = Field(min_length=1, max_length=500)


class DispatchSimulationRequest(BaseModel):
    order_id: int = Field(gt=0)
    driver_ids: list[int] | None = None


# Route optimization request schemas
class RouteStop(BaseModel):
    stop_id: str
    name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class RouteOptimizeRequest(BaseModel):
    start_latitude: float = Field(ge=-90, le=90)
    start_longitude: float = Field(ge=-180, le=180)
    stops: list[RouteStop] = Field(min_length=1, max_length=100)


# Response schemas
class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_number: str
    customer: str
    pickup: str
    destination: str
    status: str
    priority: str
    eta: str
    created_at: datetime
    driver_id: int | None = None
    pickup_latitude: float | None = None
    pickup_longitude: float | None = None
    destination_latitude: float | None = None
    destination_longitude: float | None = None
    weight_kg: float = 1.0


class DriverOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    vehicle: str
    status: str
    deliveries_today: int
    capacity_kg: float
    current_latitude: float | None = None
    current_longitude: float | None = None


class DispatchAssignRequest(BaseModel):
    driver_id: int = Field(gt=0)


@app.get("/")
def home():
    return {"message": "Welcome to FleetFlow AI API"}


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "FleetFlow AI Backend",
    }


@app.post("/locations/geocode")
def resolve_location(request: GeocodeRequest):
    """Resolve a manually entered address; user must verify the match."""
    try:
        location = geocode_address(request.address)
        return {
            "success": True,
            "searched_address": request.address,
            "latitude": location["latitude"],
            "longitude": location["longitude"],
            "matched_address": location["display_name"],
            "attribution": "© OpenStreetMap contributors",
            "verification_required": True,
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/orders", response_model=list[OrderOut])
def get_orders(db: Session = Depends(get_db)):
    return db.query(Order).order_by(Order.id.desc()).all()


@app.post(
    "/orders",
    response_model=OrderOut,
    status_code=status.HTTP_201_CREATED,
)
def create_order(
    order_data: OrderCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_roles(user, "owner", "dispatcher")
    existing_order = db.query(Order).filter(
        Order.order_number == order_data.order_number
    ).first()
    if existing_order:
        raise HTTPException(
            status_code=409,
            detail="This order number already exists.",
        )

    order = Order(**order_data.model_dump())
    try:
        db.add(order)
        db.commit()
        db.refresh(order)
        record_order_event(
            db, order.id, "created", "Order created",
            f"Order {order.order_number} entered the FleetFlow operations queue.",
        )
        create_notification(
            db,
            "New order received",
            f"{order.order_number} is ready for dispatch review.",
            severity="warning" if order.priority in {"High", "Urgent"} else "info",
            order_id=order.id,
        )
        db.commit()
        return order
    except Exception:
        db.rollback()
        raise


def release_driver_if_unused(db: Session, driver_id: int | None):
    """Mark a driver Available when they have no active assigned orders."""
    if driver_id is None:
        return

    driver = db.query(Driver).filter(Driver.id == driver_id).first()
    if driver is None:
        return

    active_order = db.query(Order).filter(
        Order.driver_id == driver_id,
        Order.status != "Delivered",
    ).first()
    if active_order is None and driver.status == "On Duty":
        driver.status = "Available"


@app.patch("/orders/{order_id}/status", response_model=OrderOut)
def update_order_status(
    order_id: int,
    update_data: OrderStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_roles(user, "owner", "dispatcher", "driver")
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")

    allowed_statuses = {
        "Pending", "In Transit", "In Progress", "Dispatched", "Delivered",
        "Failed Delivery", "Rescheduled", "Returned",
    }
    if update_data.status not in allowed_statuses:
        raise HTTPException(status_code=400, detail="Invalid order status.")

    order.status = update_data.status
    if update_data.status == "Delivered":
        release_driver_if_unused(db, order.driver_id)

    record_order_event(
        db,
        order.id,
        "status_changed",
        f"Status changed to {update_data.status}",
        f"Operations updated {order.order_number} from the dispatcher workspace.",
    )
    create_notification(
        db,
        "Delivery status updated",
        f"{order.order_number} is now {update_data.status}.",
        severity="success" if update_data.status == "Delivered" else "info",
        order_id=order.id,
    )

    db.commit()
    db.refresh(order)
    return order


# Send {"driver_id": 1} to assign, or {"driver_id": null} to unassign.
@app.patch("/orders/{order_id}/assign-driver", response_model=OrderOut)
def assign_driver(
    order_id: int,
    assignment: DriverAssignment,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_roles(user, "owner", "dispatcher")
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if order.status == "Delivered":
        raise HTTPException(
            status_code=400,
            detail="A delivered order cannot be assigned a driver.",
        )

    old_driver_id = order.driver_id
    new_driver_id = assignment.driver_id
    if new_driver_id == old_driver_id:
        return order

    new_driver = None
    if new_driver_id is not None:
        new_driver = db.query(Driver).filter(
            Driver.id == new_driver_id
        ).with_for_update().first()
        if new_driver is None:
            raise HTTPException(status_code=404, detail="Driver not found.")
        if new_driver.status != "Available":
            raise HTTPException(
                status_code=409,
                detail="This driver is not available.",
            )
        active_assignment = db.query(Order).filter(
            Order.driver_id == new_driver_id,
            Order.status != "Delivered",
        ).first()
        if active_assignment is not None:
            raise HTTPException(
                status_code=409,
                detail="This driver already has an active order.",
            )

    try:
        order.driver_id = new_driver_id
        if new_driver is not None:
            new_driver.status = "On Duty"
        release_driver_if_unused(db, old_driver_id)
        assignment_text = (
            f"{new_driver.name} was assigned to {order.order_number}."
            if new_driver is not None
            else f"Driver assignment was removed from {order.order_number}."
        )
        record_order_event(db, order.id, "assignment", "Dispatch assignment updated", assignment_text)
        create_notification(
            db,
            "Dispatch assignment updated",
            assignment_text,
            severity="info",
            order_id=order.id,
        )
        db.commit()
        db.refresh(order)
        return order
    except Exception:
        db.rollback()
        raise


@app.get("/drivers", response_model=list[DriverOut])
def get_drivers(db: Session = Depends(get_db)):
    return db.query(Driver).order_by(Driver.id.desc()).all()


@app.post(
    "/drivers",
    response_model=DriverOut,
    status_code=status.HTTP_201_CREATED,
)
def create_driver(
    driver_data: DriverCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_roles(user, "owner", "dispatcher")
    driver = Driver(**driver_data.model_dump())
    db.add(driver)
    db.commit()
    db.refresh(driver)
    return driver


@app.get("/fleet/live")
def get_live_fleet(db: Session = Depends(get_db)):
    """Return the latest known position and dispatch state for every driver."""
    payload = []
    for driver in db.query(Driver).order_by(Driver.id.asc()).all():
        latest = db.query(DriverLocation).filter(
            DriverLocation.driver_id == driver.id
        ).order_by(DriverLocation.recorded_at.desc()).first()
        payload.append({
            "driver_id": driver.id,
            "name": driver.name,
            "vehicle": driver.vehicle,
            "status": driver.status,
            "latitude": driver.current_latitude,
            "longitude": driver.current_longitude,
            "speed_kph": latest.speed_kph if latest else 0,
            "last_seen": latest.recorded_at if latest else None,
            "source": latest.source if latest else "database",
        })
    return {"drivers": payload, "updated_at": datetime.now(timezone.utc)}


@app.post("/drivers/{driver_id}/location")
async def update_driver_location(
    driver_id: int,
    location: DriverLocationUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    driver = db.query(Driver).filter(Driver.id == driver_id).first()
    if driver is None:
        raise HTTPException(status_code=404, detail="Driver not found.")

    driver.current_latitude = location.latitude
    driver.current_longitude = location.longitude
    point = DriverLocation(
        driver_id=driver_id,
        latitude=location.latitude,
        longitude=location.longitude,
        speed_kph=location.speed_kph,
        source=location.source,
    )
    db.add(point)
    nearby_orders = db.query(Order).filter(Order.driver_id == driver_id, Order.status != "Delivered").all()
    for order in nearby_orders:
        if order.destination_latitude is None or order.destination_longitude is None:
            continue
        distance_km = haversine_km(location.latitude, location.longitude, order.destination_latitude, order.destination_longitude)
        prior_geofence_event = db.query(OrderEvent).filter(OrderEvent.order_id == order.id, OrderEvent.event_type == "geofence_arrival").first()
        if distance_km <= 0.3 and prior_geofence_event is None:
            record_order_event(db, order.id, "geofence_arrival", "Driver reached delivery zone", f"{driver.name} entered the 300 m delivery geofence.")
            create_notification(db, "Driver is nearby", f"{driver.name} reached the delivery zone for {order.order_number}.", severity="success", order_id=order.id)
    db.commit()
    db.refresh(point)
    await broadcast_event({
        "event": "driver_location_updated",
        "driver_id": driver_id,
        "name": driver.name,
        "vehicle": driver.vehicle,
        "status": driver.status,
        "latitude": location.latitude,
        "longitude": location.longitude,
        "speed_kph": location.speed_kph,
        "recorded_at": point.recorded_at,
        "updated_by": user.email,
    })
    return {"success": True, "driver_id": driver_id, "recorded_at": point.recorded_at}


@app.websocket("/ws/fleet")
async def fleet_socket(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token:
        raise WebSocketException(code=1008, reason="Authentication required")
    try:
        decode_access_token(token)
    except HTTPException as exc:
        raise WebSocketException(code=1008, reason=str(exc.detail)) from exc

    await websocket.accept()
    ACTIVE_SOCKETS.add(websocket)
    await websocket.send_json({"event": "connected", "message": "Fleet live stream connected."})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ACTIVE_SOCKETS.discard(websocket)


@app.get("/notifications")
def get_notifications(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = db.query(Notification).filter(
        or_(Notification.user_id == user.id, Notification.user_id.is_(None))
    ).order_by(Notification.created_at.desc()).limit(30).all()
    return rows


@app.patch("/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    notification = db.query(Notification).filter(
        Notification.id == notification_id,
        or_(Notification.user_id == user.id, Notification.user_id.is_(None)),
    ).first()
    if notification is None:
        raise HTTPException(status_code=404, detail="Notification not found.")
    notification.is_read = True
    db.commit()
    return {"success": True}


def tracking_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@app.post("/orders/{order_id}/tracking-share")
def create_tracking_share(order_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_roles(user, "owner", "dispatcher")
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    raw_token = secrets.token_urlsafe(32)
    share = TrackingShare(
        order_id=order.id,
        token_hash=tracking_token_hash(raw_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db.add(share)
    db.commit()
    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "token": raw_token,
        "path": f"/track/{raw_token}",
        "expires_at": share.expires_at,
    }


@app.get("/tracking/public/{token}")
def get_public_tracking(token: str, db: Session = Depends(get_db)):
    share = db.query(TrackingShare).filter(
        TrackingShare.token_hash == tracking_token_hash(token),
        TrackingShare.is_active.is_(True),
    ).first()
    if share is None or share.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=404, detail="This tracking link is invalid or expired.")

    order = db.query(Order).filter(Order.id == share.order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order no longer exists.")
    driver = db.query(Driver).filter(Driver.id == order.driver_id).first() if order.driver_id else None
    events = db.query(OrderEvent).filter(
        OrderEvent.order_id == order.id
    ).order_by(OrderEvent.created_at.asc()).all()
    return {
        "order": {
            "order_number": order.order_number,
            "customer": order.customer,
            "pickup": order.pickup,
            "destination": order.destination,
            "status": order.status,
            "priority": order.priority,
            "eta": order.eta,
            "destination_latitude": order.destination_latitude,
            "destination_longitude": order.destination_longitude,
        },
        "driver": ({
            "name": driver.name,
            "vehicle": driver.vehicle,
            "status": driver.status,
            "latitude": driver.current_latitude,
            "longitude": driver.current_longitude,
        } if driver else None),
        "events": events,
        "expires_at": share.expires_at,
        "last_updated": datetime.now(timezone.utc),
    }


def calculate_order_eta(order: Order, db: Session) -> dict:
    if order.driver_id is None or order.destination_latitude is None or order.destination_longitude is None:
        raise HTTPException(status_code=422, detail="A driver and verified destination coordinates are required for ETA calculation.")
    driver = db.query(Driver).filter(Driver.id == order.driver_id).first()
    if driver is None or driver.current_latitude is None or driver.current_longitude is None:
        raise HTTPException(status_code=422, detail="The assigned driver has not sent a GPS position yet.")
    distance_km = haversine_km(
        float(driver.current_latitude), float(driver.current_longitude),
        float(order.destination_latitude), float(order.destination_longitude),
    )
    latest = db.query(DriverLocation).filter(DriverLocation.driver_id == driver.id).order_by(DriverLocation.recorded_at.desc()).first()
    speed = float(latest.speed_kph) if latest and latest.speed_kph > 8 else 28.0
    minutes = max(1, round((distance_km / speed) * 60))
    confidence = 88.0 if latest else 62.0
    label = f"{minutes} min · {distance_km:.1f} km"
    order.eta = label
    sla = db.query(OrderSLA).filter(OrderSLA.order_id == order.id).first()
    if sla is None:
        sla = OrderSLA(order_id=order.id)
        db.add(sla)
    sla.eta_minutes = minutes
    sla.eta_label = label
    sla.confidence_pct = confidence
    sla.calculated_at = datetime.now(timezone.utc)
    db.commit()
    return {"order_id": order.id, "order_number": order.order_number, "eta_label": label, "eta_minutes": minutes, "distance_km": round(distance_km, 2), "confidence_pct": confidence, "calculated_at": sla.calculated_at}


@app.post("/orders/{order_id}/eta")
def calculate_order_eta_endpoint(order_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    record_audit(db, user, "eta_calculated", "order", str(order.id), f"ETA recalculated for {order.order_number}.")
    result = calculate_order_eta(order, db)
    db.commit()
    return result


@app.get("/orders/{order_id}/geofence")
def get_order_geofence(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if not order.driver_id or order.destination_latitude is None or order.destination_longitude is None:
        return {"order_id": order.id, "nearby": False, "distance_km": None, "radius_m": 300, "reason": "Driver or destination coordinates are missing."}
    driver = db.query(Driver).filter(Driver.id == order.driver_id).first()
    if not driver or driver.current_latitude is None or driver.current_longitude is None:
        return {"order_id": order.id, "nearby": False, "distance_km": None, "radius_m": 300, "reason": "Driver GPS is not available."}
    distance_km = haversine_km(driver.current_latitude, driver.current_longitude, order.destination_latitude, order.destination_longitude)
    return {"order_id": order.id, "nearby": distance_km <= 0.3, "distance_km": round(distance_km, 3), "radius_m": 300, "reason": "Driver is inside the delivery geofence." if distance_km <= 0.3 else "Driver is approaching the destination."}


@app.post("/orders/{order_id}/proof")
def submit_delivery_proof(order_id: int, proof_data: DeliveryProofCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if not (proof_data.otp_verified or proof_data.signature_name or proof_data.photo_url):
        raise HTTPException(status_code=422, detail="At least one proof signal is required: OTP, signature or photo.")
    proof = db.query(DeliveryProof).filter(DeliveryProof.order_id == order_id).first()
    if proof is None:
        proof = DeliveryProof(order_id=order_id, driver_id=order.driver_id, **proof_data.model_dump())
        db.add(proof)
    else:
        for key, value in proof_data.model_dump().items():
            setattr(proof, key, value)
    order.status = "Delivered"
    order.eta = "Delivered with proof"
    record_order_event(db, order.id, "proof_of_delivery", "Proof of delivery captured", f"Delivery confirmed by {proof_data.recipient_name}.")
    create_notification(db, "Proof of delivery captured", f"{order.order_number} was completed with verified delivery proof.", severity="success", order_id=order.id)
    record_audit(db, user, "proof_submitted", "order", str(order.id), "Proof of delivery submitted.")
    db.commit()
    db.refresh(proof)
    return proof


@app.get("/orders/{order_id}/proof")
def get_delivery_proof(order_id: int, db: Session = Depends(get_db)):
    proof = db.query(DeliveryProof).filter(DeliveryProof.order_id == order_id).first()
    if proof is None:
        raise HTTPException(status_code=404, detail="No proof of delivery has been submitted.")
    return proof


@app.post("/orders/{order_id}/reschedule")
def reschedule_order(order_id: int, request: SLAUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    order.status = "Rescheduled"
    order.eta = request.promised_at.isoformat() if request.promised_at else "Rescheduled · customer confirmation required"
    record_order_event(db, order.id, "rescheduled", "Delivery rescheduled", "The operations team moved this delivery into a new service window.")
    create_notification(db, "Delivery rescheduled", f"{order.order_number} needs customer confirmation for its new window.", severity="warning", order_id=order.id)
    record_audit(db, user, "order_rescheduled", "order", str(order.id), "Order moved to rescheduled workflow.")
    db.commit()
    db.refresh(order)
    return order


@app.get("/exceptions")
def get_exception_inbox(db: Session = Depends(get_db)):
    orders = db.query(Order).filter(Order.status.notin_(["Delivered", "Returned"])).all()
    drivers = {driver.id: driver for driver in db.query(Driver).all()}
    exceptions = []
    for order in orders:
        risk = build_order_risk(order, drivers.get(order.driver_id))
        if risk["risk_level"] != "Stable" or order.status in {"Failed Delivery", "Rescheduled"}:
            exceptions.append({**risk, "queue": "SLA risk" if risk["risk_level"] != "Stable" else "Recovery", "owner_action": risk["suggested_action"]})
    exceptions.sort(key=lambda item: item["risk_score"], reverse=True)
    return {"count": len(exceptions), "exceptions": exceptions}


@app.post("/dispatch/simulate")
def simulate_dispatch(request: DispatchSimulationRequest, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == request.order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    recommendation = build_driver_recommendations(db, order)
    candidates = recommendation["candidates"]
    if request.driver_ids:
        candidates = [candidate for candidate in candidates if candidate["driver_id"] in request.driver_ids]
    return {"order_id": order.id, "order_number": order.order_number, "simulation": True, "recommended": candidates[0] if candidates else None, "alternatives": candidates[1:5], "method": "Capacity + proximity + workload simulation; no assignment was changed."}


@app.put("/orders/{order_id}/cod")
def update_cod(order_id: int, request: CODUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if request.amount_collected > request.amount_due:
        raise HTTPException(status_code=422, detail="Collected amount cannot exceed amount due.")
    cod = db.query(CODRecord).filter(CODRecord.order_id == order_id).first()
    if cod is None:
        cod = CODRecord(order_id=order_id)
        db.add(cod)
    cod.amount_due = request.amount_due
    cod.amount_collected = request.amount_collected
    cod.reference = request.reference
    cod.status = "Collected" if request.amount_collected == request.amount_due else "Partial" if request.amount_collected else "Pending"
    cod.collected_at = datetime.now(timezone.utc) if cod.status == "Collected" else None
    record_audit(db, user, "cod_updated", "order", str(order.id), f"COD record updated to {cod.status}.")
    db.commit()
    db.refresh(cod)
    return cod


@app.get("/cod/summary")
def get_cod_summary(db: Session = Depends(get_db)):
    rows = db.query(CODRecord).all()
    due = sum(float(row.amount_due) for row in rows)
    collected = sum(float(row.amount_collected) for row in rows)
    return {"orders": len(rows), "amount_due": round(due, 2), "amount_collected": round(collected, 2), "outstanding": round(due - collected, 2), "collection_rate_pct": round((collected / due) * 100, 1) if due else 0}


@app.post("/maintenance")
def create_maintenance(request: MaintenanceCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if db.query(Driver).filter(Driver.id == request.driver_id).first() is None:
        raise HTTPException(status_code=404, detail="Driver not found.")
    item = MaintenanceRecord(**request.model_dump())
    db.add(item)
    record_audit(db, user, "maintenance_scheduled", "driver", str(request.driver_id), f"{request.service_type} scheduled.")
    db.commit()
    db.refresh(item)
    return item


@app.get("/maintenance")
def get_maintenance(db: Session = Depends(get_db)):
    return db.query(MaintenanceRecord).order_by(MaintenanceRecord.due_date.asc().nullslast()).all()


@app.post("/integrations/orders/import")
def import_orders(request: IntegrationImport, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    existing_event = db.query(IntegrationEvent).filter(IntegrationEvent.provider == request.provider, IntegrationEvent.external_id == request.external_id).first()
    if existing_event:
        return {"status": "already_processed", "created": 0, "skipped": len(request.orders)}
    created = 0
    skipped = 0
    for order_data in request.orders:
        if db.query(Order).filter(Order.order_number == order_data.order_number).first():
            skipped += 1
            continue
        order = Order(**order_data.model_dump())
        db.add(order)
        db.flush()
        record_order_event(db, order.id, "imported", "Order imported", f"Imported from {request.provider}.")
        created += 1
    db.add(IntegrationEvent(provider=request.provider, external_id=request.external_id, payload=request.model_dump()))
    record_audit(db, user, "orders_imported", "integration", request.external_id, f"Created {created}, skipped {skipped}.")
    db.commit()
    return {"status": "processed", "created": created, "skipped": skipped}


@app.get("/audit")
def get_audit_log(db: Session = Depends(get_db)):
    return db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(100).all()



def get_driver_active_load(db: Session, driver_id: int) -> tuple[float, int]:
    """Return active assigned package weight and active order count."""
    rows = db.query(Order).filter(
        Order.driver_id == driver_id,
        Order.status != "Delivered",
    ).all()
    return (
        round(sum(float(order.weight_kg or 0) for order in rows), 2),
        len(rows),
    )


def build_order_risk(order: Order, driver: Driver | None = None) -> dict:
    """Create an explainable SLA risk score for an active order.

    This is intentionally deterministic decision support: every point in the
    score maps to an operational signal a dispatcher can verify.
    """
    score = 0
    reasons = []

    if order.priority == "Urgent":
        score += 32
        reasons.append("Urgent priority")
    elif order.priority == "High":
        score += 20
        reasons.append("High priority")

    if order.status == "Pending":
        score += 26
        reasons.append("Waiting for dispatch")
    elif order.status == "Dispatched":
        score += 6
        reasons.append("Recently dispatched")

    if order.driver_id is None:
        score += 24
        reasons.append("No driver assigned")
    elif driver and driver.status == "Off Duty":
        score += 22
        reasons.append("Assigned driver is off duty")

    if not order.eta or order.eta == "Not estimated":
        score += 10
        reasons.append("ETA is not estimated")

    if order.pickup_latitude is None or order.destination_latitude is None:
        score += 8
        reasons.append("Location verification is incomplete")

    if score >= 60:
        level = "Critical"
        action = "Dispatch now and confirm an ETA with the customer."
    elif score >= 34:
        level = "Watch"
        action = "Review driver capacity and route before the next dispatch wave."
    else:
        level = "Stable"
        action = "Continue monitoring through the normal workflow."

    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "customer": order.customer,
        "priority": order.priority,
        "status": order.status,
        "driver_id": order.driver_id,
        "driver_name": driver.name if driver else None,
        "risk_score": min(score, 100),
        "risk_level": level,
        "reasons": reasons[:4],
        "suggested_action": action,
    }


@app.get("/intelligence/brief")
def get_intelligence_brief(db: Session = Depends(get_db)):
    """Return the FleetFlow explainable operations brief for the control tower."""
    orders = db.query(Order).order_by(Order.id.desc()).all()
    drivers = db.query(Driver).order_by(Driver.id.asc()).all()
    drivers_by_id = {driver.id: driver for driver in drivers}
    active_orders = [order for order in orders if order.status != "Delivered"]

    risks = [
        build_order_risk(order, drivers_by_id.get(order.driver_id))
        for order in active_orders
    ]
    risks.sort(key=lambda item: item["risk_score"], reverse=True)

    risk_summary = {
        "critical": sum(item["risk_level"] == "Critical" for item in risks),
        "watch": sum(item["risk_level"] == "Watch" for item in risks),
        "stable": sum(item["risk_level"] == "Stable" for item in risks),
    }

    driver_load = []
    total_capacity = 0.0
    total_active_weight = 0.0
    for driver in drivers:
        active_weight, active_count = get_driver_active_load(db, driver.id)
        capacity = float(driver.capacity_kg or 0)
        total_capacity += capacity
        total_active_weight += active_weight
        utilization = round((active_weight / capacity) * 100, 1) if capacity else 100.0
        driver_load.append({
            "driver_id": driver.id,
            "name": driver.name,
            "vehicle": driver.vehicle,
            "status": driver.status,
            "capacity_kg": capacity,
            "active_weight_kg": active_weight,
            "remaining_capacity_kg": round(max(capacity - active_weight, 0), 1),
            "utilization_pct": min(utilization, 100),
            "active_orders": active_count,
            "ready_for_dispatch": driver.status in {"Available", "On Duty"},
        })

    utilization_pct = round(
        (total_active_weight / total_capacity) * 100, 1
    ) if total_capacity else 0.0
    unassigned = [order for order in active_orders if order.driver_id is None]
    urgent_unassigned = [
        order for order in unassigned if order.priority in {"Urgent", "High"}
    ]
    overloaded = [item for item in driver_load if item["utilization_pct"] >= 80]
    available = [driver for driver in drivers if driver.status == "Available"]

    recommendations = []
    if urgent_unassigned:
        recommendations.append({
            "type": "dispatch",
            "priority": "high",
            "title": f"Protect {len(urgent_unassigned)} priority shipment(s)",
            "detail": "Use the Dispatch Copilot to assign a capacity-safe driver before the SLA window narrows.",
            "impact": "Reduce preventable delay risk",
        })
    if overloaded:
        recommendations.append({
            "type": "capacity",
            "priority": "medium",
            "title": f"Rebalance {len(overloaded)} high-load driver(s)",
            "detail": "Avoid adding more weight to the most utilized vehicles; spread the next wave across the available bench.",
            "impact": "Protect vehicle capacity",
        })
    if not recommendations:
        recommendations.append({
            "type": "healthy",
            "priority": "low",
            "title": "Fleet is dispatch-ready",
            "detail": "No urgent operational exception is visible in the current database snapshot.",
            "impact": "Keep monitoring the next dispatch wave",
        })

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "engine": "SLA Shield · Explainable Operations Intelligence",
        "confidence": "High",
        "headline": (
            "Intervene before the next SLA miss"
            if risk_summary["critical"]
            else "Operations are within the control tower guardrails"
        ),
        "kpis": {
            "critical_alerts": risk_summary["critical"],
            "watchlist_orders": risk_summary["watch"],
            "unassigned_active": len(unassigned),
            "fleet_utilization_pct": utilization_pct,
            "available_drivers": len(available),
        },
        "risk_summary": risk_summary,
        "top_risks": risks[:5],
        "driver_load": driver_load,
        "recommendations": recommendations[:4],
        "methodology": [
            "Priority, dispatch state, assignment, ETA and verified coordinates are scored independently.",
            "Capacity is calculated from active order weight against each vehicle's declared limit.",
            "Every alert includes the evidence and a dispatcher-verifiable next action.",
        ],
    }


def build_driver_recommendations(db: Session, order: Order) -> dict:
    """Score eligible drivers using capacity, proximity and active workload."""
    if order.pickup_latitude is None or order.pickup_longitude is None:
        raise HTTPException(
            status_code=422,
            detail="The order needs verified pickup coordinates before dispatch recommendations can be calculated.",
        )

    drivers = db.query(Driver).filter(
        Driver.status.in_(["Available", "On Duty"])
    ).order_by(Driver.id.asc()).all()

    candidates = []
    excluded = []

    for driver in drivers:
        active_weight, active_count = get_driver_active_load(db, driver.id)
        capacity = float(driver.capacity_kg or 0)
        required_weight = float(order.weight_kg or 0)
        remaining_capacity = capacity - active_weight

        if capacity <= 0 or required_weight > remaining_capacity:
            excluded.append({
                "driver_id": driver.id,
                "driver_name": driver.name,
                "reason": (
                    f"Insufficient capacity: {remaining_capacity:.1f} kg "
                    f"available, {required_weight:.1f} kg required."
                ),
            })
            continue

        has_location = (
            driver.current_latitude is not None
            and driver.current_longitude is not None
        )

        if has_location:
            distance_km = haversine_km(
                float(driver.current_latitude),
                float(driver.current_longitude),
                float(order.pickup_latitude),
                float(order.pickup_longitude),
            )
            # Distance score falls linearly to zero at 50 km.
            proximity_score = max(0.0, 1.0 - min(distance_km, 50.0) / 50.0)
        else:
            distance_km = None
            # Neutral score; missing GPS must not be represented as nearby.
            proximity_score = 0.5

        utilization_after_assignment = (
            active_weight + required_weight
        ) / capacity
        capacity_score = max(0.0, 1.0 - utilization_after_assignment)

        # Existing active orders are a workload penalty; keep it explicit.
        workload_score = 1.0 / (1.0 + active_count)

        priority_bonus = {
            "Urgent": 1.0,
            "High": 0.5,
            "Normal": 0.0,
            "Low": 0.0,
        }.get(order.priority, 0.0)

        score = (
            proximity_score * 50
            + capacity_score * 35
            + workload_score * 15
        )
        # Priority is shown as context, not used to unfairly alter driver suitability.
        score = round(score, 1)

        reasons = [
            f"{remaining_capacity:.1f} kg capacity available before assignment.",
            f"{active_count} active order(s) currently assigned.",
        ]
        if has_location:
            reasons.append(f"Driver is approximately {distance_km:.1f} km from pickup.")
        else:
            reasons.append(
                "Driver location is unavailable; proximity was scored neutrally."
            )
        if utilization_after_assignment <= 0.5:
            reasons.append("Vehicle will remain at or below 50% capacity utilization.")
        elif utilization_after_assignment < 1:
            reasons.append("Vehicle has sufficient capacity, with limited spare room.")

        candidates.append({
            "driver_id": driver.id,
            "driver_name": driver.name,
            "vehicle": driver.vehicle,
            "status": driver.status,
            "score": score,
            "distance_to_pickup_km": (
                round(distance_km, 2) if distance_km is not None else None
            ),
            "capacity_kg": capacity,
            "current_active_load_kg": active_weight,
            "order_weight_kg": required_weight,
            "remaining_capacity_after_assignment_kg": round(
                remaining_capacity - required_weight, 2
            ),
            "active_order_count": active_count,
            "reasons": reasons,
        })

    candidates.sort(key=lambda item: item["score"], reverse=True)

    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "priority": order.priority,
        "package_weight_kg": float(order.weight_kg or 0),
        "recommendation_method": (
            "Weighted decision score: proximity 50%, remaining capacity 35%, "
            "active workload 15%. Missing driver GPS receives a neutral "
            "proximity score, not an assumed distance."
        ),
        "recommended_driver": candidates[0] if candidates else None,
        "candidates": candidates,
        "excluded_drivers": excluded,
        "requires_manager_approval": True,
        "note": (
            "This is a rule-based decision-support recommendation, not an "
            "autonomous AI assignment. GPS distance is used only when driver "
            "coordinates are available. Vehicle capacity is treated as a "
            "maximum package-weight constraint."
        ),
    }


@app.get("/dispatch/recommend/{order_id}")
def recommend_driver_for_order(
    order_id: int,
    db: Session = Depends(get_db),
):
    """Recommend suitable drivers without changing any assignments."""
    order = db.query(Order).filter(Order.id == order_id).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if order.status == "Delivered":
        raise HTTPException(
            status_code=400,
            detail="A delivered order cannot be dispatched.",
        )
    return build_driver_recommendations(db, order)


@app.post("/dispatch/assign/{order_id}", response_model=OrderOut)
def assign_recommended_driver(
    order_id: int,
    request: DispatchAssignRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_roles(user, "owner", "dispatcher")
    """Apply a manager-approved driver assignment after rechecking constraints."""
    order = db.query(Order).filter(Order.id == order_id).with_for_update().first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if order.status == "Delivered":
        raise HTTPException(
            status_code=400,
            detail="A delivered order cannot be assigned a driver.",
        )

    driver = db.query(Driver).filter(
        Driver.id == request.driver_id
    ).with_for_update().first()
    if driver is None:
        raise HTTPException(status_code=404, detail="Driver not found.")
    if driver.status not in {"Available", "On Duty"}:
        raise HTTPException(
            status_code=409,
            detail="Driver is not available for dispatch.",
        )
    if order.pickup_latitude is None or order.pickup_longitude is None:
        raise HTTPException(
            status_code=422,
            detail="Verified pickup coordinates are required before dispatch.",
        )

    active_weight, _ = get_driver_active_load(db, driver.id)
    required_weight = float(order.weight_kg or 0)
    capacity = float(driver.capacity_kg or 0)

    if active_weight + required_weight > capacity:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Capacity exceeded. Driver has {max(0.0, capacity - active_weight):.1f} kg "
                f"available, but this order requires {required_weight:.1f} kg."
            ),
        )

    old_driver_id = order.driver_id
    try:
        order.driver_id = driver.id
        driver.status = "On Duty"
        release_driver_if_unused(db, old_driver_id)
        record_order_event(
            db,
            order.id,
            "assignment",
            "Dispatch Copilot assignment approved",
            f"{driver.name} was assigned after the manager approved the Copilot recommendation.",
        )
        create_notification(
            db,
            "Copilot assignment approved",
            f"{driver.name} is now assigned to {order.order_number}.",
            severity="success",
            order_id=order.id,
        )
        db.commit()
        db.refresh(order)
        return order
    except Exception:
        db.rollback()
        raise


@app.get("/routes/stops-from-orders")
def get_route_stops_from_orders(db: Session = Depends(get_db)):
    orders = (
        db.query(Order)
        .filter(Order.status != "Delivered")
        .order_by(Order.id.asc())
        .all()
    )

    stops = []
    skipped_orders = []
    for order in orders:
        coordinates = [
            order.pickup_latitude,
            order.pickup_longitude,
            order.destination_latitude,
            order.destination_longitude,
        ]
        if any(value is None for value in coordinates):
            skipped_orders.append({
                "order_id": order.id,
                "order_number": order.order_number,
                "reason": "Pickup or destination coordinates are missing",
            })
            continue

        stops.append({
            "stop_id": f"order-{order.id}-pickup",
            "name": f"{order.order_number} - Pickup: {order.pickup}",
            "latitude": order.pickup_latitude,
            "longitude": order.pickup_longitude,
        })
        stops.append({
            "stop_id": f"order-{order.id}-destination",
            "name": f"{order.order_number} - Destination: {order.destination}",
            "latitude": order.destination_latitude,
            "longitude": order.destination_longitude,
        })

    return {
        "total_active_orders": len(orders),
        "orders_included": len(stops) // 2,
        "orders_skipped": len(skipped_orders),
        "stops": stops,
        "skipped_orders": skipped_orders,
        "note": (
            "Only non-delivered orders with complete pickup and "
            "destination coordinates are included."
        ),
    }


@app.post("/routes/optimize")
def calculate_optimized_route(request: RouteOptimizeRequest):
    stop_ids = [stop.stop_id for stop in request.stops]
    if len(stop_ids) != len(set(stop_ids)):
        raise HTTPException(
            status_code=400,
            detail="Each stop_id must be unique.",
        )

    stops = [stop.model_dump() for stop in request.stops]
    return optimize_stops(
        start_lat=request.start_latitude,
        start_lon=request.start_longitude,
        stops=stops,
    )


@app.post("/routes/optimize-road")
def calculate_road_optimized_route(request: RouteOptimizeRequest):
    stop_ids = [stop.stop_id for stop in request.stops]
    if len(stop_ids) != len(set(stop_ids)):
        raise HTTPException(
            status_code=400,
            detail="Each stop_id must be unique.",
        )

    try:
        return calculate_road_route(
            start_lat=request.start_latitude,
            start_lon=request.start_longitude,
            stops=[stop.model_dump() for stop in request.stops],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    total_orders = db.query(func.count(Order.id)).scalar() or 0

    active_deliveries = (
        db.query(func.count(Order.id))
        .filter(Order.status.in_(
            ["In Transit", "In Progress", "Dispatched"]
        ))
        .scalar()
        or 0
    )
    available_drivers = (
        db.query(func.count(Driver.id))
        .filter(Driver.status == "Available")
        .scalar()
        or 0
    )
    delivered_orders = (
        db.query(func.count(Order.id))
        .filter(Order.status == "Delivered")
        .scalar()
        or 0
    )
    on_time_orders = (
        db.query(func.count(Order.id))
        .filter(
            Order.status == "Delivered",
            Order.eta == "On Time",
        )
        .scalar()
        or 0
    )
    on_time_rate = (
        round(on_time_orders / delivered_orders * 100, 1)
        if delivered_orders > 0
        else 0.0
    )

    return {
        "total_orders": total_orders,
        "active_deliveries": active_deliveries,
        "available_drivers": available_drivers,
        "on_time_rate": on_time_rate,
        "delivered_orders": delivered_orders,
    }
