# Circuits.com

A functional prototype of an electronic components directory for [circuits.com](https://circuits.com). Built as a demo showcasing what a modern, animated redesign of the site could look like -- complete with category browsing, supplier listings, keyword sponsorships, and automated workflows.

## Architecture

```
                        Browser
                           |
                      Nginx (:80)
                      /         \
                     /           \
          Frontend (:3000)    API (:8000)
          Vite React SPA      FastAPI
                                 |
                            PostgreSQL (:5432)
                                 |
                             n8n (:5678)
                          Workflow Automation
```

Five Docker containers orchestrated by Docker Compose:

| Service      | Image / Build       | Port  | Purpose                        |
|--------------|---------------------|-------|--------------------------------|
| **nginx**    | nginx:alpine        | 80    | Reverse proxy, route splitting |
| **frontend** | ./frontend          | 3000  | React SPA                      |
| **api**      | ./api               | 8000  | REST API                       |
| **db**       | postgres:16-alpine  | 5432  | Persistent data store          |
| **n8n**      | ./n8n               | 5678  | Workflow automation            |

Nginx routes `/api/*` to the API and everything else to the frontend.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+)
- [Docker Compose](https://docs.docker.com/compose/) (v2+)

## Quick Start

```bash
docker compose up --build
```

Open [http://localhost](http://localhost) in your browser.

On first launch the API container automatically runs Alembic migrations and seeds the database with demo data (14 categories, ~50 subcategories, 7 suppliers, 2 sponsors).

### Production Build

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

Uses a multi-stage frontend build (static files served by nginx) and runs uvicorn with 4 workers.

## Pages and Routes

| Route                    | Page             | Description                                     |
|--------------------------|------------------|-------------------------------------------------|
| `/`                      | Home             | Hero with animated circuit traces, category grid |
| `/category/:slug`        | Category Detail  | Supplier table, sponsor block                    |
| `/search?q=`             | Search           | Full-text search results                         |
| `/join`                  | Join             | Supplier application form                        |
| `/contact`               | Contact          | Contact form                                     |
| `/about`                 | About            | Value proposition, how it works                  |
| `/keyword/:keyword`      | Keyword Sponsor  | Sponsor landing page for keyword campaigns       |

## API Endpoints

All endpoints are prefixed with `/api`.

| Method | Path                          | Description                       |
|--------|-------------------------------|-----------------------------------|
| GET    | `/api/health`                 | Health check                      |
| GET    | `/api/categories`             | List all categories               |
| GET    | `/api/categories/:slug`       | Category detail with subcategories and suppliers |
| GET    | `/api/search?q=`              | Search categories and suppliers   |
| GET    | `/api/suppliers`              | List all suppliers                |
| GET    | `/api/sponsors/keyword/:keyword` | Sponsor info for a keyword     |
| POST   | `/api/contact`                | Submit contact form               |
| POST   | `/api/join`                   | Submit supplier application       |
| POST   | `/api/keyword-request`        | Request keyword sponsorship       |

Interactive docs are available at [http://localhost:8000/docs](http://localhost:8000/docs) (Swagger UI) when the API container is running.

## n8n Workflows

Three webhook-driven workflows handle form submissions, defined as JSON in `n8n/workflows/`:

| Workflow                | Webhook Path               | Trigger                    |
|-------------------------|----------------------------|----------------------------|
| Supplier Onboarding     | `/webhook/supplier-onboard`| POST `/api/join`           |
| Contact Form            | `/webhook/contact`         | POST `/api/contact`        |
| Keyword Request         | `/webhook/keyword-request` | POST `/api/keyword-request`|

The API forwards form submissions to n8n via HTTP. Workflows can be extended in the n8n UI at [http://localhost:5678](http://localhost:5678) to add email notifications, Slack alerts, CRM integration, etc.

## Kubernetes Deployment

Manifests live in the `k8s/` directory and target the `circuits` namespace:

```
k8s/
  namespace.yml            # circuits namespace
  db-deployment.yml        # PostgreSQL with PVC
  api-deployment.yml       # FastAPI deployment + service
  frontend-deployment.yml  # Frontend deployment + service
  n8n-deployment.yml       # n8n deployment + PVC + service
  nginx-ingress.yml        # Ingress resource (host: circuits.com)
```

Deploy to a cluster:

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/
```

## Tech Stack

**Frontend**
- React 19, TypeScript, Vite 6
- SCSS Modules for scoped styling
- Framer Motion for page transitions and animations
- React Router 7 for client-side routing
- Axios for API calls

**Backend**
- Python 3.12, FastAPI
- SQLAlchemy 2.0 (async-compatible ORM)
- Alembic for database migrations
- Pydantic for request/response validation
- Uvicorn ASGI server

**Database**
- PostgreSQL 16 (Alpine)

**Automation**
- n8n (self-hosted workflow automation)

**Infrastructure**
- Docker and Docker Compose
- Nginx reverse proxy
- Kubernetes manifests for cluster deployment

## Project Structure

```
.
├── api/                  # FastAPI backend
│   ├── alembic/          #   Database migrations
│   ├── app/
│   │   ├── db/           #   Database connection + seed data
│   │   ├── models/       #   SQLAlchemy models
│   │   ├── routes/       #   API route handlers
│   │   ├── schemas/      #   Pydantic schemas
│   │   ├── services/     #   Business logic
│   │   ├── config.py     #   Settings
│   │   └── main.py       #   FastAPI application
│   └── tests/            #   API tests
├── frontend/             # React SPA
│   └── src/
│       ├── components/   #   Reusable UI components
│       ├── hooks/        #   Custom React hooks
│       ├── pages/        #   Page components
│       ├── services/     #   API client
│       ├── styles/       #   Global SCSS + variables
│       └── types/        #   TypeScript type definitions
├── k8s/                  # Kubernetes manifests
├── n8n/                  # n8n workflow definitions
│   └── workflows/
├── nginx/                # Nginx configuration
├── docker-compose.yml    # Development compose
└── docker-compose.prod.yml  # Production overrides
```

## Seed Data

The demo ships with pre-loaded data:

- **14 categories** (Capacitors, Connectors, Diodes, ICs, Inductors, LEDs, Memory, Microcontrollers, Passives, Power Supplies, Relays, Resistors, Sensors, Transistors) with ~50 subcategories
- **7 suppliers** -- Avnet, Arrow, Digi-Key, Future Electronics, Kennedy Electronics, Mouser, TTI
- **2 sponsors** -- Kennedy Electronics (gold category sponsor), Avnet (silver keyword sponsor)
