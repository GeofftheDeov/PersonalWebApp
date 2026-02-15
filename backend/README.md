# Backend Service

This is the backend service for the Personal Web App, built with Node.js and Express.

## Features

- **User Authentication**: Secure JWT-based authentication with bcrypt password hashing.
- **Salesforce Integration**: Real-time and batch synchronization of Accounts and Leads using JSforce.
- **Database**: MongoDB integration using Mongoose for flexible data modeling.
- **Nodemailer**: Integrated email service for password resets and notifications.

## Tech Stack

- **Framework**: Express.js
- **Database**: MongoDB (Mongoose)
- **Authentication**: JsonWebToken (JWT) & bcryptjs
- **Integration**: JSforce (Salesforce API)
- **Environment**: dotenv

## API Endpoints

### User Routes (`/api/users`)

- `POST /register`: Create a new user account.
- `POST /login`: Authenticate and receive a JWT.
- `POST /forgot-password`: Request a password reset link.
- `POST /reset-password`: Reset password using a valid token.

### Database Routes (`/api/db`)

- `GET /stats`: Retrieve database status and statistics.

### Salesforce Routes (`/api/accounts`, `/api/leads`)

- `POST /sync`: Synchronize data with Salesforce.

## Scripts

The `scripts/` directory contains useful utilities:

- `generate_cert.ts`: Generates self-signed SSL certificates for local HTTPS development.
- `generateJWT.ts`: Generates a long-lived JWT for Salesforce integration testing.
- `verify_models.ts`: Script to validate MongoDB models and connection.

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

- `PORT`: Server port (default: 5000)
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret key for JWT signing
- `SF_LOGIN_URL`, `SF_USERNAME`, `SF_CLIENT_ID`, `SF_PRIVATE_KEY_PATH`: Salesforce JWT flow credentials.
