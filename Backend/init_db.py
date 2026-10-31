
from app.database import Base, engine
from app import models

Base.metadata.create_all(bind=engine)

print("FleetFlow AI database tables created successfully!")
print("Tables: orders, drivers, users, driver_locations, notifications, order_events, tracking_shares")
