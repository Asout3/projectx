# Quick Setup Guide

## 5-Minute Setup

### 1. Install Dependencies

```bash
# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install
```

### 2. Create Environment Files

**Frontend** - Create `frontend/.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_API_URL=http://localhost:5000
```

**Backend** - Create `backend/.env`:
```env
PORT=5000
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_key
```

### 3. Setup Services

#### Supabase
1. Go to https://supabase.com
2. Create new project
3. Copy URL and keys from Settings > API
4. Database schema is auto-created
5. Create storage bucket named `documents` (make it public)

#### Firebase
1. Go to https://console.firebase.google.com
2. Create project
3. Enable Authentication
4. Enable Email/Password + Google sign-in
5. Update `frontend/auth/firebaseSDK.ts` with your config

### 4. Run Development Servers

```bash
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Frontend
cd frontend
npm run dev
```

Visit `http://localhost:3000`

## Troubleshooting

### "Supabase not configured"
- Check `.env` files have correct values
- Restart servers after adding env variables

### "Authentication failed"
- Verify Firebase config in `firebaseSDK.ts`
- Check Firebase console for enabled auth methods

### "CORS error"
- Backend `server.js` already configured for localhost
- For production, update CORS origin in `backend/server.js`

### iOS Google Sign-in not working
- Uses redirect flow automatically
- Ensure Firebase authorized domains include your deployment URL

## Production Checklist

- [ ] Update Firebase config with production domain
- [ ] Set production API URL in frontend env
- [ ] Configure CORS for production domain
- [ ] Set up Supabase production environment
- [ ] Enable RLS policies on all tables
- [ ] Set up error monitoring (Sentry, etc.)
- [ ] Configure rate limiting
- [ ] Set up automated backups
- [ ] Add monitoring for API usage

## Environment Variables Reference

### Required for Frontend
- `NEXT_PUBLIC_SUPABASE_URL` - Get from Supabase dashboard
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Get from Supabase dashboard
- `NEXT_PUBLIC_API_URL` - Your backend URL

### Required for Backend
- `PORT` - Server port (5000 recommended)
- `SUPABASE_URL` - Get from Supabase dashboard
- `SUPABASE_SERVICE_ROLE_KEY` - Get from Supabase dashboard (keep secret!)

### Optional
- `GEMINI_API_KEY` - For AI generation (if using Gemini)

## Next Steps

1. Test document generation
2. Check document storage in Supabase
3. Test sharing feature
4. Verify iOS authentication
5. Test DOCX export
6. Deploy to production

## Support

Need help? Check:
- README.md for full documentation
- GitHub issues for common problems
- Supabase docs: https://supabase.com/docs
- Firebase docs: https://firebase.google.com/docs
