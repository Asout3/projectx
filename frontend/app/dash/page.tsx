"use client";

import { useState, useMemo } from "react";
import axios from "axios";
import Greet from "../../components/greet";
import { auth } from "../../auth/firebaseSDK"; //  Make sure this path is correct
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Button,
  Selection
} from "@heroui/react";

const api = axios.create({
  baseURL: "https://projectx-c5md.onrender.com", // use your deployed server in production   // main baseURL is https://projectx-c5md.onrender.com
  headers: {
    "Content-Type": "application/json",
  },
});

export default function PromptSender() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfLink, setPdfLink] = useState<string | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Selection>(
    new Set(["book_small"])
  );

  const selectedValue = useMemo(
    () => Array.from(selectedKeys)[0],
    [selectedKeys]
  );

  const apiMap: Record<string, string> = {
    book_small: "/api/generateBookSmall",
    book_medium: "/api/generateBookMed",
    book_long: "/api/generateBookLong",
    research: "/api/generateResearchPaper",
    research_long: "/api/generateResearchPaperLong",
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setResponse("⚠️ Please enter a prompt first.");
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      setResponse("❌ You must be logged in.");
      return;
    }

    const userId = user.uid;

    setIsGeneratingPDF(true);
    setPdfProgress(0);

    const endpoint = apiMap[selectedValue] || apiMap["book_small"];

    try {
      const res = await api.post(
        endpoint,
        { prompt, userId }, // 👈 send userId with prompt
        {
          responseType: "blob",
          onDownloadProgress: (e) => {
            const total = e.total ?? 1_000_000;
            setPdfProgress(Math.min(100, Math.round((e.loaded * 100) / total)));
          },
        }
      );

      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const fileName = `${prompt.slice(0, 20).replace(/\s+/g, "_") || "book"}.pdf`;

      setPdfLink(url);
      setPdfFileName(fileName);
    } catch (err: any) {
      console.error(err);
      if (err.isAxiosError && err.response?.status === 0) {
        setResponse("❌ CORS/network issue – could not connect to server.");
      } else {
        setResponse("❌ PDF generation failed.");
      }
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <Greet />
      <textarea
        className="w-full p-3 border rounded-lg mb-3 outline-none"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="generate me a book about cats"
      />

      <div className="flex gap-2 mb-4 items-center">
        <Dropdown>
          <DropdownTrigger>
            <Button className="capitalize" variant="bordered">
              {{
                book_small: "Small Book",
                book_medium: "Medium Book",
                book_long: "Long Book",
                research: "Research Paper",
                research_long: "Long Research Paper",
              }[selectedValue] || "Select File Type"}
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label="Select File Type"
            disallowEmptySelection
            selectedKeys={selectedKeys}
            selectionMode="single"
            onSelectionChange={setSelectedKeys}
          >
            <DropdownItem key="book_small">Small Book</DropdownItem>
            <DropdownItem key="book_medium">Medium Book</DropdownItem>
            <DropdownItem key="book_long">Long Book</DropdownItem>
            <DropdownItem key="research">Research Paper</DropdownItem>
            <DropdownItem key="research_long">Long Research Paper</DropdownItem>
          </DropdownMenu>
        </Dropdown>

        <Button
          onClick={handleGenerate}
          disabled={isGeneratingPDF}
          className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {isGeneratingPDF
            ? `Generating (${pdfProgress}%)`
            : "Generate"}
        </Button>
      </div>

      {pdfLink && (
        <div className="mt-4">
          <a
            href={pdfLink}
            download={pdfFileName}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded inline-block"
          >
            Download Your Guide (PDF)
          </a>
        </div>
      )}

      {isGeneratingPDF && (
        <div className="mt-2">
          <div className="bg-gray-300 rounded-full h-2.5 w-full">
            <div
              className="bg-blue-500 h-2.5 rounded-full"
              style={{ width: `${pdfProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
