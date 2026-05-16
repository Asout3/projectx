**Purpose:** Revoke and rotate secrets immediately if they are committed, and keep secrets out of the repo.

- **Do not commit** `.env` or any file with credentials.
- Use the repository's secret storage (GitHub Actions secrets, Vercel/Render/Netlify/Cloud Run/VM environment settings) for deploy-time secrets.

Emergency steps if secrets were committed:

1. Revoke or rotate the compromised keys immediately in the provider dashboard.
2. Replace the keys in your local `backend/.env` (do not commit).
3. If secrets were committed to git history, purge them (we used `git-filter-repo` for this repository).
4. Notify collaborators to re-clone the repository after a history rewrite.

How to use locally:

1. Create `backend/.env` from local values (do not commit):
```
CEREBRAS_API_KEY=your_new_value
GEMINI_API_KEY=your_new_value
TOGETHER_API_KEY=your_new_value
SUPABASE_SERVICE_ROLE_KEY=your_new_value
```

2. Install `pre-commit` and enable hooks:
```
pip install pre-commit detect-secrets
pre-commit install
```

3. Use deployment secret stores for CI and hosting platforms.
