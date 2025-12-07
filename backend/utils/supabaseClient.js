import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials not configured. Document storage features will be disabled.');
}

export const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export async function createDocument(userId, title, type, format = 'pdf') {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await supabase
    .from('documents')
    .insert({
      user_id: userId,
      title,
      type,
      format,
      generation_status: 'processing',
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating document:', error);
    throw error;
  }

  return data;
}

export async function updateDocumentStatus(documentId, status, fileUrl = null, fileSize = 0) {
  if (!supabase) return;

  const updates = {
    generation_status: status,
  };

  if (fileUrl) {
    updates.file_url = fileUrl;
    updates.file_size = fileSize;
  }

  const { error } = await supabase
    .from('documents')
    .update(updates)
    .eq('id', documentId);

  if (error) {
    console.error('Error updating document:', error);
    throw error;
  }
}

export async function uploadFile(buffer, fileName, contentType) {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await supabase.storage
    .from('documents')
    .upload(fileName, buffer, {
      contentType,
      upsert: false,
    });

  if (error) {
    console.error('Error uploading file:', error);
    throw error;
  }

  const { data: urlData } = supabase.storage
    .from('documents')
    .getPublicUrl(fileName);

  return urlData.publicUrl;
}
