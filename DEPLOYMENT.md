# Deployment Guide

## Production Deployment

### Prerequisites

- Vercel account (for frontend)
- Railway/Heroku account (for backend)
- Supabase production project
- Firebase production project
- Custom domain (optional)

## Frontend Deployment (Vercel)

### 1. Prepare for Deployment

```bash
cd frontend
npm run build
```

Verify build succeeds without errors.

### 2. Deploy to Vercel

#### Option A: Vercel CLI

```bash
npm install -g vercel
vercel login
vercel
```

#### Option B: GitHub Integration

1. Push code to GitHub
2. Import project in Vercel dashboard
3. Connect repository
4. Configure build settings:
   - Framework: Next.js
   - Root Directory: `frontend`
   - Build Command: `npm run build`
   - Output Directory: `.next`

### 3. Configure Environment Variables

In Vercel dashboard, add:

```env
NEXT_PUBLIC_SUPABASE_URL=your_production_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_production_anon_key
NEXT_PUBLIC_API_URL=your_production_backend_url
```

### 4. Configure Firebase

1. Add Vercel domain to Firebase authorized domains:
   - Go to Firebase Console > Authentication > Settings
   - Add `your-app.vercel.app` to authorized domains

2. Update CORS in Firebase:
   - Allow your Vercel domain

### 5. Deploy

Click "Deploy" in Vercel dashboard. Deployment takes 2-5 minutes.

## Backend Deployment (Railway)

### 1. Prepare Backend

```bash
cd backend
npm install
```

Create `Procfile`:
```
web: npm start
```

### 2. Deploy to Railway

1. Create new project in Railway
2. Connect GitHub repository
3. Select `backend` directory as root
4. Railway auto-detects Node.js

### 3. Configure Environment Variables

In Railway dashboard, add:

```env
PORT=5000
SUPABASE_URL=your_production_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_production_service_role_key
GEMINI_API_KEY=your_gemini_api_key
```

### 4. Update CORS

Edit `backend/server.js`:

```javascript
app.use(cors({
  origin: ['https://your-app.vercel.app'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));
```

### 5. Deploy

Railway deploys automatically on push to main branch.

## Database Setup (Supabase)

### 1. Create Production Project

1. Go to https://supabase.com
2. Create new project (production tier recommended)
3. Note project URL and keys

### 2. Run Migrations

Migrations are already applied via the MCP tool. Verify in Supabase dashboard:
- Check Tables > documents exists
- Verify RLS policies are enabled
- Check Functions exist

### 3. Create Storage Bucket

1. Go to Storage in Supabase dashboard
2. Create bucket named `documents`
3. Set to public
4. Configure policies:

```sql
-- Allow authenticated users to upload
CREATE POLICY "Allow authenticated uploads"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'documents');

-- Allow public reads
CREATE POLICY "Allow public reads"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'documents');
```

## Post-Deployment Checklist

### Security

- [ ] All API keys in environment variables
- [ ] CORS configured correctly
- [ ] RLS enabled on all tables
- [ ] Storage bucket policies set
- [ ] Firebase authorized domains updated
- [ ] Rate limiting configured (optional)

### Testing

- [ ] Test user registration
- [ ] Test Google sign-in on iOS
- [ ] Generate small book
- [ ] Generate research paper
- [ ] Test DOCX export
- [ ] Test document history
- [ ] Test share functionality
- [ ] Test on mobile devices

### Monitoring

- [ ] Set up error tracking (Sentry)
- [ ] Configure logging
- [ ] Set up uptime monitoring
- [ ] Monitor API usage
- [ ] Set up database backups

### Performance

- [ ] Enable CDN (Vercel does this automatically)
- [ ] Optimize images
- [ ] Enable caching
- [ ] Monitor response times
- [ ] Set up analytics

## Alternative Deployment Options

### Backend Alternatives

#### Heroku

```bash
heroku create your-app-name
git push heroku main
heroku config:set SUPABASE_URL=...
```

#### DigitalOcean App Platform

1. Connect GitHub repo
2. Select backend directory
3. Add environment variables
4. Deploy

#### Render

1. Create Web Service
2. Connect repository
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables

### Frontend Alternatives

#### Netlify

```bash
npm install -g netlify-cli
netlify deploy --prod
```

#### GitHub Pages (Static Export)

Update `next.config.js`:
```javascript
module.exports = {
  output: 'export',
  images: { unoptimized: true }
}
```

Then:
```bash
npm run build
```

Deploy `out` directory to GitHub Pages.

## Custom Domain Setup

### Frontend (Vercel)

1. Go to Project Settings > Domains
2. Add your custom domain
3. Configure DNS:
   - Type: CNAME
   - Name: @ or subdomain
   - Value: cname.vercel-dns.com

### Backend (Railway)

1. Go to Settings > Networking
2. Add custom domain
3. Configure DNS:
   - Type: CNAME
   - Name: api (or subdomain)
   - Value: provided by Railway

## Environment Variables Summary

### Frontend (Public - Safe to Expose)

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
```

### Backend (Private - Keep Secret)

```env
PORT=5000
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
GEMINI_API_KEY=...
```

## Rollback Plan

### Frontend

1. Go to Vercel dashboard
2. Deployments tab
3. Click previous deployment
4. Click "Promote to Production"

### Backend

1. Revert commit in GitHub
2. Railway auto-deploys previous version
3. Or manually rollback in Railway dashboard

## Troubleshooting

### "CORS Error"

- Check backend CORS configuration includes frontend domain
- Verify both HTTP and HTTPS are allowed
- Check for trailing slashes

### "Database Connection Failed"

- Verify SUPABASE_URL is correct
- Check SERVICE_ROLE_KEY is set (not anon key)
- Verify database is not paused

### "Authentication Failed"

- Verify Firebase config matches production
- Check authorized domains in Firebase
- Test redirect URLs

### "File Upload Failed"

- Verify storage bucket exists and is public
- Check RLS policies on storage
- Verify SUPABASE_SERVICE_ROLE_KEY has permissions

## Support

For deployment issues:
- Check logs in Vercel/Railway dashboard
- Review Supabase logs
- Check Firebase authentication logs
- Open GitHub issue

## Cost Estimates

### Free Tier (Development)

- Vercel: Free hobby plan
- Supabase: Free tier (500MB database, 1GB storage)
- Railway: $5 credit/month
- Firebase: Free Spark plan

### Production (Low Traffic)

- Vercel: $20/month Pro plan
- Supabase: $25/month Pro plan
- Railway: ~$10-20/month
- Firebase: Pay as you go (~$5-10/month)

**Total: ~$60-75/month**

### Production (High Traffic)

- Vercel: $20/month + usage
- Supabase: $25-100/month
- Railway: $50-100/month
- Firebase: $20-50/month

**Total: ~$115-270/month**

---

Deployment complete! Your app should now be live.
