# EduManage API (`server`)

Express + **Prisma** + PostgreSQL. Tenant scope uses **`schoolId` on the server session** (HttpOnly cookie). School-specific routes never trust a `schoolId` from the browser.

## Setup

From this directory (`server` / `school mgt be`):

```bash
docker compose up -d
npm install
copy .env.example .env
npm run db:generate
npm run db:migrate -- --name init
npm run dev
```

API: [http://localhost:4000](http://localhost:4000)

## Authentication API

| Method | Endpoint | Function |
|--------|----------|----------|
| POST | `/api/auth/register` | Register a school and administrator (creates session) |
| POST | `/api/auth/login` | Authenticate with **school slug** + email + password |
| GET | `/api/auth/me` | Current user, school tenant, role |
| POST | `/api/auth/logout` | End session |
| GET | `/api/dashboard` | School-scoped dashboard stats (session `schoolId`) |
| GET | `/api/school/settings` | School profile (School Admin) |
| PUT | `/api/school/settings` | Update school profile (tenant from session) |
| GET/POST/PUT/DELETE | `/api/students` | Student directory & admission (Phase 3) |
| GET/POST/PUT | `/api/academics/*` | Staff, years, classes, streams, subjects, assignments (Phase 4) |
| GET/POST | `/api/attendance/*` | Daily registers & attendance analytics (Phase 5) |
| GET/POST/PUT | `/api/examinations/*` | Exams, marks, publish (Phase 5) |
| GET/PUT | `/api/grading/bands` | School grade bands (Phase 5) |
| GET | `/api/assessment/analytics` | Performance summary (Phase 5) |
| GET | `/api/reports/students/:id/report-card` | Printable report card (Phase 5) |
| GET/POST/PUT | `/api/finance/*` | Fee structures, invoices, payments, receipts (Phase 6) |
| GET/POST | `/api/enrollments` | Structured enrollment; `PUT …/teacher-link` (Phase 6) |
| GET | `/api/admin/check` | School Admin authorization test |

## Prisma models

| Model | Purpose |
|-------|---------|
| School | Each tenant |
| User | Login credentials |
| Membership | User ↔ school + role |
| Session | DB-backed sessions (`connect-pg-simple`) |

## Test registration

```json
{
  "schoolName": "Green Hill Academy",
  "slug": "green-hill-academy",
  "email": "admin@greenhill.example",
  "password": "ChangeThisPassword2026!"
}
```

Register a second school, sign in with each **slug** separately, and confirm `/api/dashboard` returns the matching `schoolId`.
