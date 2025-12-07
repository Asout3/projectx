"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getDocumentByShareToken, Document } from "../../../lib/supabase";
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from "@heroui/react";
import Link from "next/link";

export default function SharedDocumentPage() {
  const params = useParams();
  const token = params.token as string;
  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadDocument();
  }, [token]);

  const loadDocument = async () => {
    try {
      setLoading(true);
      const doc = await getDocumentByShareToken(token);
      if (doc) {
        setDocument(doc);
      } else {
        setError("Document not found or not shared");
      }
    } catch (err) {
      console.error("Error loading shared document:", err);
      setError("Failed to load document");
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
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

  if (error || !document) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <Card className="max-w-md">
          <CardBody className="text-center py-12">
            <h2 className="text-2xl font-bold mb-4 text-red-600">Document Not Found</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              {error || "This document doesn't exist or is no longer shared."}
            </p>
            <Link href="/">
              <Button color="primary">Go Home</Button>
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 mt-8">
      <Card>
        <CardHeader className="flex flex-col items-start gap-4 pb-6">
          <div className="flex gap-2">
            <Chip color="primary" variant="flat">{document.format.toUpperCase()}</Chip>
            <Chip color="secondary" variant="flat">{getTypeLabel(document.type)}</Chip>
          </div>
          <h1 className="text-3xl font-bold">{document.title}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Shared on {formatDate(document.created_at)}
          </p>
        </CardHeader>
        <CardBody>
          <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                This document was created using Bookgen.ai
              </p>
            </div>

            {document.file_url ? (
              <div className="space-y-4">
                <Button
                  color="primary"
                  size="lg"
                  className="w-full"
                  as="a"
                  href={document.file_url}
                  target="_blank"
                  download
                >
                  Download Document ({document.format.toUpperCase()})
                </Button>

                {document.format === 'pdf' && (
                  <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
                    <iframe
                      src={document.file_url}
                      className="w-full"
                      style={{ height: '600px' }}
                      title="Document Preview"
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="text-center text-gray-600 dark:text-gray-400">
                File not available for download
              </p>
            )}

            <div className="text-center pt-6 border-t border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Want to create your own documents?
              </p>
              <Link href="/dash">
                <Button color="secondary" variant="flat">
                  Try Bookgen.ai
                </Button>
              </Link>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
