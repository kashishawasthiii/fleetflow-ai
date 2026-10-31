"""Load a small, realistic FleetFlow operations snapshot for demos."""

from app.database import Base, SessionLocal, engine
from app.models import Driver, Order


def seed_demo_data():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(Order).first() or db.query(Driver).first():
            print("Demo data skipped: the database already contains records.")
            return

        drivers = [
            Driver(name="Aarav Sharma", vehicle="Tata Ace · UP78-AX-1024", status="On Duty", deliveries_today=4, capacity_kg=550, current_latitude=26.4499, current_longitude=80.3319),
            Driver(name="Meera Singh", vehicle="Mahindra Bolero · UP78-BQ-4410", status="Available", deliveries_today=2, capacity_kg=800, current_latitude=26.4761, current_longitude=80.3490),
            Driver(name="Kabir Khan", vehicle="Eicher Pro · UP78-CR-7821", status="Available", deliveries_today=6, capacity_kg=1500, current_latitude=26.4632, current_longitude=80.3180),
            Driver(name="Ishita Verma", vehicle="Piaggio Ape · UP78-DM-9033", status="Off Duty", deliveries_today=3, capacity_kg=350),
        ]
        db.add_all(drivers)
        db.flush()

        orders = [
            Order(order_number="FF-2401", customer="Nexora Retail", pickup="Kanpur Central", destination="Swaroop Nagar, Kanpur", status="Pending", priority="Urgent", eta="Not estimated", driver_id=None, weight_kg=42, pickup_latitude=26.4538, pickup_longitude=80.3512, destination_latitude=26.4841, destination_longitude=80.3138),
            Order(order_number="FF-2402", customer="GreenBasket Foods", pickup="Panki Industrial Area", destination="Civil Lines, Kanpur", status="Dispatched", priority="High", eta="Today 15:20", driver_id=drivers[0].id, weight_kg=115, pickup_latitude=26.4376, pickup_longitude=80.2144, destination_latitude=26.4711, destination_longitude=80.3463),
            Order(order_number="FF-2403", customer="Studio 91", pickup="Kakadeo", destination="IIT Kanpur", status="In Transit", priority="Normal", eta="Today 16:05", driver_id=drivers[0].id, weight_kg=68, pickup_latitude=26.4855, pickup_longitude=80.3007, destination_latitude=26.5123, destination_longitude=80.2329),
            Order(order_number="FF-2404", customer="Medix Pharmacy", pickup="Arya Nagar", destination="Kalyanpur", status="Pending", priority="High", eta="Not estimated", driver_id=None, weight_kg=24, pickup_latitude=26.4774, pickup_longitude=80.3288, destination_latitude=26.5127, destination_longitude=80.2320),
            Order(order_number="FF-2405", customer="Urban Loom", pickup="Phool Bagh", destination="Kidwai Nagar", status="Delivered", priority="Normal", eta="On Time", driver_id=None, weight_kg=55, pickup_latitude=26.4691, pickup_longitude=80.3509, destination_latitude=26.4347, destination_longitude=80.3247),
            Order(order_number="FF-2406", customer="QuickFix Services", pickup="Nawabganj", destination="Sharda Nagar", status="Pending", priority="Low", eta="Not estimated", driver_id=None, weight_kg=18, pickup_latitude=26.4983, pickup_longitude=80.2782, destination_latitude=26.4828, destination_longitude=80.2677),
        ]
        db.add_all(orders)
        db.commit()
        print("FleetFlow demo snapshot loaded: 4 drivers and 6 orders.")
    finally:
        db.close()


if __name__ == "__main__":
    seed_demo_data()
