# Bookgen.ai - AI-Powered Document Generator

A production-ready web application that uses AI to generate complete books and research papers in PDF and DOCX formats.

## Features

- **Multiple Document Types**
  - Small Books (5 chapters)
  - Medium Books (10 chapters)
  - Long Books (15+ chapters)
  - Research Papers

- **Format Options**
  - PDF export with professional formatting
  - DOCX export for easy editing

- **User Management**
  - Firebase Authentication (Email/Password + Google Sign-in)
  - iOS-optimized redirect authentication
  - Persistent user sessions

- **Document Management**
  - View all generated documents
  - Download documents anytime
  - Delete unwanted documents
  - Share documents with public links

- **Production Features**
  - Document storage with Supabase
  - Real-time generation progress
  - Cancel generation mid-process
  - Responsive design for all devices
  - Dark mode support

## Tech Stack

### Frontend
- Next.js 15
- TypeScript
- HeroUI (UI Components)
- Tailwind CSS
- Firebase Auth
- Supabase Client
- Axios

### Backend
- Node.js with Express
- Together AI (LLM API)
- Puppeteer (PDF generation)
- Docx library (DOCX generation)
- Supabase (Database & Storage)
- Winston (Logging)

## Prerequisites

- Node.js 18+ and npm
- Firebase project
- Supabase project
- Together AI API key

## Setup Instructions

### 1. Clone Repository

```bash
git clone <your-repo-url>
cd project
```

### 2. Frontend Setup

```bash
cd frontend
npm install
```

Create `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_API_URL=http://localhost:5000
```

Update Firebase config in `frontend/auth/firebaseSDK.ts`:

```typescript
const firebaseConfig = {
  apiKey: "your_firebase_api_key",
  authDomain: "your_firebase_auth_domain",
  projectId: "your_firebase_project_id",
  storageBucket: "your_firebase_storage_bucket",
  messagingSenderId: "your_firebase_messaging_sender_id",
  appId: "your_firebase_app_id",
  measurementId: "your_firebase_measurement_id"
};
```

Run development server:

```bash
npm run dev
```

Frontend will be available at `http://localhost:3000`

### 3. Backend Setup

```bash
cd backend
npm install
```

Create `.env` file:

```env
PORT=5000
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
GEMINI_API_KEY=your_gemini_api_key
```

Run backend server:

```bash
npm start
```

Backend will be available at `http://localhost:5000`

### 4. Supabase Setup

The database schema is already created through migrations. You need to:

1. Create a Supabase project at https://supabase.com
2. Get your project URL and keys from Settings > API
3. Run the migration (already applied via `mcp__supabase__apply_migration`)
4. Create a storage bucket named `documents` for file storage

#### Storage Setup

1. Go to Storage in Supabase dashboard
2. Create a new bucket called `documents`
3. Set it to **public** for easy file access
4. Configure RLS policies if needed

### 5. Firebase Setup

1. Create a Firebase project at https://console.firebase.google.com
2. Enable Authentication
3. Enable Email/Password and Google sign-in methods
4. Add your domain to authorized domains
5. Copy configuration to `frontend/auth/firebaseSDK.ts`

## Database Schema

### documents table

- `id` (uuid) - Primary key
- `user_id` (uuid) - Foreign key to auth.users
- `title` (text) - Document title/topic
- `type` (text) - Document type (book_small, book_medium, book_long, research_long)
- `format` (text) - File format (pdf, docx)
- `file_url` (text) - URL to stored file
- `file_size` (bigint) - File size in bytes
- `share_token` (text) - Unique token for sharing
- `is_public` (boolean) - Public access flag
- `generation_status` (text) - Status (pending, processing, completed, failed)
- `created_at` (timestamptz) - Creation timestamp
- `updated_at` (timestamptz) - Last update timestamp

## API Endpoints

### Generation Endpoints

- `POST /api/generateBookSmall` - Generate small book
- `POST /api/generateBookMed` - Generate medium book
- `POST /api/generateBookLong` - Generate long book
- `POST /api/generateResearchPaperLong` - Generate research paper

Request body:
```json
{
  "prompt": "Your topic",
  "userId": "user_firebase_uid",
  "format": "pdf" // or "docx"
}
```

### Document Management

- `GET /api/documents/:userId` - Get user documents
- `DELETE /api/documents/:documentId` - Delete document
- `POST /api/documents/:documentId/share` - Generate share link
- `GET /api/share/:token` - Get shared document

### Utility

- `POST /api/cancelGeneration` - Cancel ongoing generation

## Project Structure

```
project/
├── frontend/
│   ├── app/
│   │   ├── dash/          # Main dashboard
│   │   ├── documents/     # Document history
│   │   ├── login/         # Authentication
│   │   ├── share/         # Shared documents
│   │   └── page.tsx       # Landing page
│   ├── components/        # Reusable components
│   ├── lib/              # Utilities (Supabase client)
│   └── auth/             # Firebase configuration
├── backend/
│   ├── controllers/      # API controllers
│   ├── routes/           # API routes
│   ├── utils/            # Utilities (Supabase, DOCX)
│   ├── AI/               # Document generation logic
│   └── server.js         # Express server
└── README.md
```

## Environment Variables

### Frontend

- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anon key
- `NEXT_PUBLIC_API_URL` - Backend API URL

### Backend

- `PORT` - Server port (default: 5000)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `GEMINI_API_KEY` - Gemini API key for AI generation

## Deployment

### Frontend (Vercel)

1. Connect your GitHub repository to Vercel
2. Add environment variables in Vercel dashboard
3. Deploy

### Backend (Railway/Heroku)

1. Connect your GitHub repository
2. Set environment variables
3. Deploy with `npm start`
4. Update `NEXT_PUBLIC_API_URL` in frontend to production URL

## Security

- All API keys and secrets are stored in environment variables
- Firebase handles authentication securely
- Row Level Security (RLS) enabled on all Supabase tables
- CORS configured for specific origins only
- Share tokens are randomly generated and unique

## Features in Detail

### Document Generation

The app uses Together AI's LLM models to generate structured content. Each document type has:
- Specific prompt engineering for quality output
- Chapter/section breakdown
- Professional formatting
- Citations and references (for research papers)

### File Storage

Generated documents are:
1. Created temporarily on server
2. Uploaded to Supabase Storage
3. Linked in database with metadata
4. Made available for download
5. Temporary files cleaned up

### Sharing

Documents can be shared via:
1. Unique share tokens
2. Public URLs
3. Direct file downloads
4. Optional: Make private again by removing share token

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - feel free to use for personal or commercial projects

## Support

For issues or questions, please open a GitHub issue or contact the maintainer.

## Roadmap

- [ ] Add more document types (novels, essays, etc.)
- [ ] Support more AI models
- [ ] Collaborative editing
- [ ] Custom templates
- [ ] Batch generation
- [ ] Analytics dashboard
- [ ] API rate limiting
- [ ] Webhook notifications

---

Built with Next.js, Express, Supabase, and Firebase
