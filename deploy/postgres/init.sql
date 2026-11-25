-- Database-per-service: each service owns its schema and never reads another service's DB.
CREATE DATABASE users_db;
CREATE DATABASE orders_db;
CREATE DATABASE payments_db;
CREATE DATABASE notifications_db;
