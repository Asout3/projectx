"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "../../auth/firebaseSDK";
import { getUserDocuments, deleteDocument, generateShareToken, Document } from "../../lib/supabase";
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from "@heroui/react";
import Link from "next/link";

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [shareLoading, setShareLoading] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        await loadDocuments(currentUser.uid);
      } else {
        router.push("/login");
      }
    });

    return () => unsubscribe();
  }, [router]);

  const loadDocuments = async (userId: string) => {
    try {
      setLoading(true);
      const docs = await getUserDocuments(userId);
      setDocuments(docs);
    } catch (error) {
      console.error("Error loading documents:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    try {
      await deleteDocument(id);
      setDocuments(documents.filter(doc => doc.id !== id));
    } catch (error) {
      console.error("Error deleting document:", error);
      alert("Failed to delete document");
    }
  };

  const handleShare = async (id: string) => {
    try {
      setShareLoading(id);
      const token = await generateShareToken(id);
      const shareUrl = `${window.location.origin}/share/${token}`;
      await navigator.clipboard.writeText(shareUrl);
      alert("Share link copied to clipboard!");
    } catch (error) {
      console.error("Error generating share link:", error);
      alert("Failed to generate share link");
    } finally {
      setShareLoading(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'success';
      case 'processing': return 'warning';
      case 'failed': return 'danger';
      default: return 'default';
    }
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      book_small: 'Small Book',
      book_medium: 'Medium Book',
      book_long: 'Long Book',
      research_long: 'Research Paper'
    };
    return labels[type] || type;
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-4 mt-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">My Documents</h1>
        <Link href="/dash">
          <Button color="primary">Create New</Button>
        </Link>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              You haven't created any documents yet.
            </p>
            <Link href="/dash">
              <Button color="primary">Create Your First Document</Button>
            </Link>
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {documents.map((doc) => (
            <Card key={doc.id} className="hover:shadow-lg transition-shadow">
              <CardHeader className="flex flex-col items-start gap-2">
                <div className="flex justify-between w-full">
                  <Chip size="sm" variant="flat">{doc.format.toUpperCase()}</Chip>
                  <Chip size="sm" color={getStatusColor(doc.generation_status)} variant="flat">
                    {doc.generation_status}
                  </Chip>
                </div>
                <h3 className="text-lg font-semibold line-clamp-2">{doc.title}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {getTypeLabel(doc.type)}
                </p>
              </CardHeader>
              <CardBody>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Size:</span>
                    <span>{formatFileSize(doc.file_size)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Created:</span>
                    <span>{formatDate(doc.created_at)}</span>
                  </div>
                  {doc.is_public && (
                    <Chip size="sm" color="success" variant="flat" className="w-full">
                      Shared
                    </Chip>
                  )}
                </div>

                <div className="flex gap-2 mt-4">
                  {doc.file_url && doc.generation_status === 'completed' && (
                    <Button
                      size="sm"
                      color="primary"
                      variant="flat"
                      className="flex-1"
                      as="a"
                      href={doc.file_url}
                      target="_blank"
                    >
                      Download
                    </Button>
                  )}
                  <Button
                    size="sm"
                    color="secondary"
                    variant="flat"
                    className="flex-1"
                    isLoading={shareLoading === doc.id}
                    onClick={() => handleShare(doc.id)}
                  >
                    Share
                  </Button>
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    onClick={() => handleDelete(doc.id)}
                  >
                    Delete
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
