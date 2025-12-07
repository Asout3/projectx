import fs from 'fs';
import path from 'path';
import { generateBookS } from '../AI/SB.js';
import { generateBookMedd } from '../AI/MB.js';
import { generateBookL } from '../AI/LB.js';
import { generateResearchPaperS } from '../test/RS.js';
import { generateResearchPaperLongg } from '../test/RL.js';
import { generateDocx } from '../utils/docxGenerator.js';
import { createDocument, updateDocumentStatus, uploadFile, supabase } from '../utils/supabaseClient.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function handleDocumentGeneration(req, res, generateFn, docType) {
  let documentId = null;
  let filePath = null;

  try {
    const { prompt, userId, format = 'pdf' } = req.body;

    if (!prompt || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`Document Request - Type: ${docType}, Format: ${format}, User: ${userId}`);

    if (supabase) {
      const document = await createDocument(userId, prompt, docType, format);
      documentId = document.id;
    }

    const pdfPath = await generateFn(prompt, userId);

    if (!fs.existsSync(pdfPath)) {
      if (documentId) {
        await updateDocumentStatus(documentId, 'failed');
      }
      return res.status(500).json({ error: 'Generation failed' });
    }

    if (format === 'docx') {
      const markdownContent = fs.readFileSync(
        pdfPath.replace('.pdf', '-combined.txt'),
        'utf8'
      );
      const docxPath = pdfPath.replace('.pdf', '.docx');
      await generateDocx(markdownContent, docxPath);
      filePath = docxPath;
    } else {
      filePath = pdfPath;
    }

    let fileUrl = null;
    const fileSize = fs.statSync(filePath).size;

    if (supabase && documentId) {
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = `${userId}/${documentId}.${format}`;
      fileUrl = await uploadFile(fileBuffer, fileName, format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      await updateDocumentStatus(documentId, 'completed', fileUrl, fileSize);
    }

    const downloadName = format === 'pdf' ? 'document.pdf' : 'document.docx';
    res.download(filePath, downloadName, (err) => {
      if (err) {
        console.error('Error sending file:', err);
        if (!res.headersSent) res.sendStatus(500);
      }
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting file:', unlinkErr);
      });
      if (format === 'docx' && pdfPath !== filePath) {
        fs.unlink(pdfPath, () => {});
      }
    });

  } catch (error) {
    console.error('Document generation error:', error);
    if (documentId) {
      await updateDocumentStatus(documentId, 'failed');
    }
    res.status(500).json({ error: 'Failed to generate document' });
  }
}

export async function generateBookSmall(req, res) {
  return handleDocumentGeneration(req, res, generateBookS, 'book_small');
}

export async function generateBookMed(req, res) {
  return handleDocumentGeneration(req, res, generateBookMedd, 'book_medium');
}

export async function generateBookLong(req, res) {
  return handleDocumentGeneration(req, res, generateBookL, 'book_long');
}

export async function generateResearchPaper(req, res) {
  return handleDocumentGeneration(req, res, generateResearchPaperS, 'research_paper');
}

export async function generateResearchPaperLong(req, res) {
  return handleDocumentGeneration(req, res, generateResearchPaperLongg, 'research_long');
}

export async function getUserDocuments(req, res) {
  try {
    const { userId } = req.params;

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ documents: data || [] });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
}

export async function deleteUserDocument(req, res) {
  try {
    const { documentId } = req.params;
    const { userId } = req.body;

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { error } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
}

export async function generateShareLink(req, res) {
  try {
    const { documentId } = req.params;
    const { userId } = req.body;

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data: tokenData } = await supabase.rpc('generate_share_token');
    const shareToken = tokenData;

    const { data, error } = await supabase
      .from('documents')
      .update({ share_token: shareToken, is_public: true })
      .eq('id', documentId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ shareToken, shareUrl: `${req.protocol}://${req.get('host')}/share/${shareToken}` });
  } catch (error) {
    console.error('Error generating share link:', error);
    res.status(500).json({ error: 'Failed to generate share link' });
  }
}

export async function getSharedDocument(req, res) {
  try {
    const { token } = req.params;

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('share_token', token)
      .eq('is_public', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Document not found or not shared' });
    }

    res.json({ document: data });
  } catch (error) {
    console.error('Error fetching shared document:', error);
    res.status(500).json({ error: 'Failed to fetch shared document' });
  }
}
