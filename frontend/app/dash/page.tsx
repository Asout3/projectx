"use client";

import { useState, useMemo } from "react";
import axios from "axios";
import Link from "next/link";
import Greet from "../../components/greet";
import { auth } from "../../auth/firebaseSDK";
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Button,
  Selection,
  Card,
  CardBody,
  Radio,
  RadioGroup,
  Textarea,
} from "@heroui/react";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "https://projectx-production-d880.up.railway.app",
  headers: {
    "Content-Type": "application/json",
  },
});

export default function Dashboard() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileLink, setFileLink] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<Selection>(new Set(["book_small"]));
  const [selectedFormat, setSelectedFormat] = useState("pdf");

  const selectedTypeValue = useMemo(
    () => Array.from(selectedType)[0] as string,
    [selectedType]
  );

  const apiMap: Record<string, string> = {
    book_small: "/api/generateBookSmall",
    book_medium: "/api/generateBookMed",
    book_long: "/api/generateBookLong",
    research_long: "/api/generateResearchPaperLong",
  };

  const typeLabels: Record<string, string> = {
    book_small: "Small Book",
    book_medium: "Medium Book",
    book_long: "Long Book",
    research_long: "Research Paper",
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setResponse("Please enter a topic first");
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      setResponse("You must be logged in");
      return;
    }

    setIsGenerating(true);
    setProgress(0);
    setFileLink(null);
    setResponse("");

    const endpoint = apiMap[selectedTypeValue];

    try {
      const res = await api.post(
        endpoint,
        { prompt, userId: user.uid, format: selectedFormat },
        {
          responseType: "blob",
          onDownloadProgress: (e) => {
            const total = e.total ?? 1_000_000;
            setProgress(Math.min(100, Math.round((e.loaded * 100) / total)));
          },
        }
      );

      const mimeType = selectedFormat === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const blob = new Blob([res.data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const name = `${prompt.slice(0, 20).replace(/\s+/g, "_")}.${selectedFormat}`;

      setFileLink(url);
      setFileName(name);
      setResponse("Generation complete!");
    } catch (err: any) {
      console.error(err);
      setResponse(err.response?.data?.error || "Generation failed. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCancel = async () => {
    const user = auth.currentUser;
    if (!user) return;

    try {
      await api.post("/api/cancelGeneration", { userId: user.uid });
      setResponse("Generation cancelled");
    } catch (err) {
      console.error("Cancel failed:", err);
    }
    setIsGenerating(false);
  };

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <Greet />
        <Link href="/documents">
          <Button color="secondary" variant="flat">
            My Documents
          </Button>
        </Link>
      </div>

      <Card>
        <CardBody className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              What would you like to create?
            </label>
            <Textarea
              placeholder="E.g., A comprehensive guide to machine learning for beginners"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isGenerating}
              minRows={3}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Document Type
              </label>
              <Dropdown>
                <DropdownTrigger>
                  <Button variant="bordered" className="w-full justify-start">
                    {typeLabels[selectedTypeValue]}
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label="Select document type"
                  disallowEmptySelection
                  selectedKeys={selectedType}
                  selectionMode="single"
                  onSelectionChange={setSelectedType}
                >
                  <DropdownItem key="book_small">Small Book (5 chapters)</DropdownItem>
                  <DropdownItem key="book_medium">Medium Book (10 chapters)</DropdownItem>
                  <DropdownItem key="book_long">Long Book (15+ chapters)</DropdownItem>
                  <DropdownItem key="research_long">Research Paper</DropdownItem>
                </DropdownMenu>
              </Dropdown>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Format
              </label>
              <RadioGroup
                value={selectedFormat}
                onValueChange={setSelectedFormat}
                orientation="horizontal"
                isDisabled={isGenerating}
              >
                <Radio value="pdf">PDF</Radio>
                <Radio value="docx">DOCX</Radio>
              </RadioGroup>
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              color="primary"
              size="lg"
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
              className="flex-1"
            >
              {isGenerating ? `Generating... ${progress}%` : "Generate"}
            </Button>

            {isGenerating && (
              <Button
                color="danger"
                size="lg"
                variant="flat"
                onClick={handleCancel}
              >
                Cancel
              </Button>
            )}
          </div>

          {isGenerating && (
            <div className="space-y-2">
              <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-blue-600 h-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-sm text-center text-gray-600 dark:text-gray-400">
                This may take a few minutes...
              </p>
            </div>
          )}

          {fileLink && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <p className="text-green-800 dark:text-green-200 font-medium mb-3">
                Your document is ready!
              </p>
              <Button
                color="success"
                size="lg"
                as="a"
                href={fileLink}
                download={fileName}
                className="w-full"
              >
                Download {selectedFormat.toUpperCase()}
              </Button>
              <p className="text-sm text-center mt-3 text-gray-600 dark:text-gray-400">
                View all your documents in{" "}
                <Link href="/documents" className="text-blue-600 hover:underline">
                  My Documents
                </Link>
              </p>
            </div>
          )}

          {response && !fileLink && (
            <div className={`${response.includes("complete") ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"} dark:bg-opacity-20 border rounded-lg p-4 text-sm`}>
              {response}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
        <div className="p-4">
          <h3 className="font-semibold text-lg mb-2">Fast Generation</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            AI-powered content creation in minutes
          </p>
        </div>
        <div className="p-4">
          <h3 className="font-semibold text-lg mb-2">Multiple Formats</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Export as PDF or DOCX
          </p>
        </div>
        <div className="p-4">
          <h3 className="font-semibold text-lg mb-2">Easy Sharing</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Generate shareable links instantly
          </p>
        </div>
      </div>
    </div>
  );
}
