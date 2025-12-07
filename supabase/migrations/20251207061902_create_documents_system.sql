/*
  # Document Management System Schema
  
  ## Overview
  This migration creates the core document management system for storing user-generated PDFs and DOCX files.
  
  ## New Tables
  
  ### `documents`
  Stores all generated documents with metadata and file references.
  - `id` (uuid, primary key) - Unique document identifier
  - `user_id` (uuid, foreign key) - Reference to auth.users
  - `title` (text) - Document title/topic
  - `type` (text) - Generation type: book_small, book_medium, book_long, research_long
  - `format` (text) - File format: pdf or docx
  - `file_url` (text) - URL to stored file in Supabase Storage
  - `file_size` (bigint) - File size in bytes
  - `share_token` (text, unique, nullable) - Token for public sharing
  - `is_public` (boolean) - Whether document is publicly accessible
  - `generation_status` (text) - Status: pending, processing, completed, failed
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp
  
  ## Security
  - RLS enabled on all tables
  - Users can only access their own documents
  - Public documents accessible via share token
  - Authenticated users only can create documents
*/

-- Create documents table
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  type text NOT NULL CHECK (type IN ('book_small', 'book_medium', 'book_long', 'research_long')),
  format text NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf', 'docx')),
  file_url text,
  file_size bigint DEFAULT 0,
  share_token text UNIQUE,
  is_public boolean DEFAULT false,
  generation_status text DEFAULT 'pending' CHECK (generation_status IN ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id);
CREATE INDEX IF NOT EXISTS documents_share_token_idx ON documents(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_created_at_idx ON documents(created_at DESC);

-- Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Users can view their own documents
CREATE POLICY "Users can view own documents"
  ON documents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Users can view public documents via share token
CREATE POLICY "Anyone can view public shared documents"
  ON documents FOR SELECT
  TO authenticated, anon
  USING (is_public = true AND share_token IS NOT NULL);

-- Users can insert their own documents
CREATE POLICY "Users can create own documents"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own documents
CREATE POLICY "Users can update own documents"
  ON documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own documents
CREATE POLICY "Users can delete own documents"
  ON documents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER update_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to generate share token
CREATE OR REPLACE FUNCTION generate_share_token()
RETURNS text AS $$
BEGIN
  RETURN encode(gen_random_bytes(16), 'base64');
END;
$$ LANGUAGE plpgsql;
