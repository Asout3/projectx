# Quick Start Guide

## Get Running in 10 Minutes

### Step 1: Install Dependencies (2 min)

```bash
# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install
```

### Step 2: Create Accounts (3 min)

1. **Supabase** - https://supabase.com
   - Create project
   - Copy URL and anon key
   - Create storage bucket: `documents` (public)

2. **Firebase** - https://console.firebase.google.com
   - Create project
   - Enable Authentication
   - Enable Email/Password + Google

### Step 3: Environment Setup (2 min)

**Frontend** - Create `frontend/.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=paste_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=paste_here
NEXT_PUBLIC_API_URL=http://localhost:5000
```

**Backend** - Create `backend/.env`:
```env
PORT=5000
SUPABASE_URL=paste_here
SUPABASE_SERVICE_ROLE_KEY=paste_here
```

**Firebase** - Update `frontend/auth/firebaseSDK.ts` with your config

### Step 4: Run (1 min)

```bash
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend
cd frontend
npm run dev
```

Open http://localhost:3000

### Step 5: Test (2 min)

1. Sign up with email/password
2. Generate a small book
3. Check "My Documents"
4. Try sharing a document
5. Test DOCX export

## Common Commands

```bash
# Start development
npm run dev              # Frontend
npm start               # Backend

# Build for production
npm run build           # Frontend

# Lint code
npm run lint            # Frontend
```

## Project Structure

```
project/
├── frontend/           # Next.js app
│   ├── app/           # Pages
│   ├── components/    # UI components
│   ├── lib/          # Supabase client
│   └── auth/         # Firebase config
│
└── backend/           # Express API
    ├── controllers/  # API logic
    ├── routes/       # Endpoints
    ├── utils/        # Helpers
    └── AI/          # Generation logic
```

## Key Features

- **Generate Documents**: Books and research papers
- **Export Formats**: PDF and DOCX
- **Save History**: All documents stored
- **Share**: Generate public links
- **iOS Compatible**: Works on all devices

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Cannot connect" | Check backend is running on port 5000 |
| "Auth failed" | Verify Firebase config |
| "Database error" | Check Supabase credentials |
| "CORS error" | Backend CORS already configured |

## Next Steps

1. Read [README.md](./README.md) for full documentation
2. Check [SETUP.md](./SETUP.md) for detailed setup
3. See [DEPLOYMENT.md](./DEPLOYMENT.md) for going live
4. Review [CHANGES.md](./CHANGES.md) for what's new

## Support

- Documentation: See README.md
- Issues: Open GitHub issue
- Setup help: Check SETUP.md

## Quick Tips

- Default server: `http://localhost:5000`
- Default frontend: `http://localhost:3000`
- PDF generation takes 2-5 minutes
- Documents auto-saved to database
- Share links never expire
- DOCX files are editable in Word

---

That's it! You should now have a working AI document generator.
