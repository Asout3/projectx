import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not found. Some features may not work.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Document {
  id: string;
  user_id: string;
  title: string;
  type: 'book_small' | 'book_medium' | 'book_long' | 'research_long';
  format: 'pdf' | 'docx';
  file_url: string | null;
  file_size: number;
  share_token: string | null;
  is_public: boolean;
  generation_status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

export async function getUserDocuments(userId: string): Promise<Document[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching documents:', error);
    throw error;
  }

  return data || [];
}

export async function createDocument(doc: Partial<Document>): Promise<Document> {
  const { data, error } = await supabase
    .from('documents')
    .insert(doc)
    .select()
    .single();

  if (error) {
    console.error('Error creating document:', error);
    throw error;
  }

  return data;
}

export async function updateDocument(id: string, updates: Partial<Document>): Promise<Document> {
  const { data, error } = await supabase
    .from('documents')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating document:', error);
    throw error;
  }

  return data;
}

export async function deleteDocument(id: string): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting document:', error);
    throw error;
  }
}

export async function generateShareToken(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('generate_share_token');

  if (error) {
    console.error('Error generating share token:', error);
    throw error;
  }

  const shareToken = data;

  await updateDocument(id, { share_token: shareToken, is_public: true });

  return shareToken;
}

export async function getDocumentByShareToken(token: string): Promise<Document | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('share_token', token)
    .eq('is_public', true)
    .single();

  if (error) {
    console.error('Error fetching shared document:', error);
    return null;
  }

  return data;
}
