import { describe, expect, it } from "vitest";
import { fileExtension, fileKindLabel, getFileKind } from "@/lib/utils/drive";

const item = (name: string, mimeType: string | null = null) => ({ name, mimeType });

describe("getFileKind — MIME type detection", () => {
  it("detects images from image/* MIME types", () => {
    expect(getFileKind(item("photo", "image/jpeg"))).toBe("image");
    expect(getFileKind(item("photo.png", "image/png"))).toBe("image");
    expect(getFileKind(item("clipart", "image/svg+xml"))).toBe("image");
  });

  it("detects videos from video/* MIME types", () => {
    expect(getFileKind(item("clip", "video/mp4"))).toBe("video");
    expect(getFileKind(item("clip.mov", "video/quicktime"))).toBe("video");
  });

  it("detects audio from audio/* MIME types", () => {
    expect(getFileKind(item("song", "audio/mpeg"))).toBe("audio");
    expect(getFileKind(item("song.flac", "audio/flac"))).toBe("audio");
  });

  it("detects spreadsheets", () => {
    expect(getFileKind(item("data", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe("spreadsheet");
    expect(getFileKind(item("data", "application/vnd.ms-excel"))).toBe("spreadsheet");
    expect(getFileKind(item("data", "text/csv"))).toBe("spreadsheet");
  });

  it("detects documents", () => {
    expect(getFileKind(item("notes", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe("document");
    expect(getFileKind(item("notes", "application/msword"))).toBe("document");
    expect(getFileKind(item("notes", "text/plain"))).toBe("document");
    expect(getFileKind(item("notes", "application/rtf"))).toBe("document");
  });

  it("detects presentations", () => {
    expect(getFileKind(item("deck", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))).toBe("presentation");
    expect(getFileKind(item("deck", "application/vnd.ms-powerpoint"))).toBe("presentation");
  });

  it("detects pdf", () => {
    expect(getFileKind(item("manual", "application/pdf"))).toBe("pdf");
  });

  it("detects archives", () => {
    expect(getFileKind(item("bundle", "application/zip"))).toBe("archive");
    expect(getFileKind(item("bundle", "application/x-rar-compressed"))).toBe("archive");
    expect(getFileKind(item("bundle", "application/x-7z-compressed"))).toBe("archive");
  });

  it("detects design files before the generic image/* rule", () => {
    expect(getFileKind(item("artwork", "image/vnd.adobe.photoshop"))).toBe("design");
    expect(getFileKind(item("artwork", "application/postscript"))).toBe("design");
    expect(getFileKind(item("artwork", "application/illustrator"))).toBe("design");
  });

  it("detects Google Workspace MIME types", () => {
    expect(getFileKind(item("Sheet", "application/vnd.google-apps.spreadsheet"))).toBe("spreadsheet");
    expect(getFileKind(item("Doc", "application/vnd.google-apps.document"))).toBe("document");
    expect(getFileKind(item("Slides", "application/vnd.google-apps.presentation"))).toBe("presentation");
  });

  it("ignores MIME parameters", () => {
    expect(getFileKind(item("notes", "text/plain; charset=utf-8"))).toBe("document");
  });
});

describe("getFileKind — extension fallback", () => {
  const OCTET = "application/octet-stream";

  it("falls back to the extension when MIME is application/octet-stream", () => {
    expect(getFileKind(item("BA Automation Media Creation - v2.xlsx", OCTET))).toBe("spreadsheet");
    expect(getFileKind(item("report.docx", OCTET))).toBe("document");
    expect(getFileKind(item("deck.pptx", OCTET))).toBe("presentation");
    expect(getFileKind(item("manual.pdf", OCTET))).toBe("pdf");
    expect(getFileKind(item("bundle.zip", OCTET))).toBe("archive");
    expect(getFileKind(item("bundle.rar", OCTET))).toBe("archive");
    expect(getFileKind(item("bundle.7z", OCTET))).toBe("archive");
    expect(getFileKind(item("artwork.psd", OCTET))).toBe("design");
    expect(getFileKind(item("artwork.ai", OCTET))).toBe("design");
    expect(getFileKind(item("song.mp3", OCTET))).toBe("audio");
    expect(getFileKind(item("clip.mp4", OCTET))).toBe("video");
    expect(getFileKind(item("photo.jpg", OCTET))).toBe("image");
  });

  it("falls back to the extension when MIME is missing or unmatched", () => {
    expect(getFileKind(item("report.docx", null))).toBe("document");
    expect(getFileKind(item("report.docx", "application/x-unknown"))).toBe("document");
  });

  it("prefers MIME type over a misleading extension", () => {
    expect(getFileKind(item("not-really.xlsx", "image/png"))).toBe("image");
    expect(getFileKind(item("spreadsheet-named.png", "application/pdf"))).toBe("pdf");
  });

  it("returns other for unknown extensions and names without one", () => {
    expect(getFileKind(item("data.weirdext", OCTET))).toBe("other");
    expect(getFileKind(item("no-extension", OCTET))).toBe("other");
    expect(getFileKind(item("no-extension", null))).toBe("other");
    expect(getFileKind(item(".hiddenfile", OCTET))).toBe("other");
  });
});

describe("fileExtension", () => {
  it("returns the uppercase extension", () => {
    expect(fileExtension("file.xlsx")).toBe("XLSX");
    expect(fileExtension("archive.tar.gz")).toBe("GZ");
  });

  it("returns null when there is no usable extension", () => {
    expect(fileExtension("noext")).toBeNull();
    expect(fileExtension(".hidden")).toBeNull();
    expect(fileExtension("trailing.")).toBeNull();
  });
});

describe("fileKindLabel", () => {
  it("labels the acceptance xlsx as an Excel spreadsheet", () => {
    expect(fileKindLabel(item("BA Automation Media Creation - v2.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe("Excel spreadsheet");
    expect(fileKindLabel(item("BA Automation Media Creation - v2.xlsx", "application/octet-stream"))).toBe("Excel spreadsheet");
  });

  it("labels other kinds", () => {
    expect(fileKindLabel(item("data.csv", "text/csv"))).toBe("CSV file");
    expect(fileKindLabel(item("report.docx", "application/msword"))).toBe("Word document");
    expect(fileKindLabel(item("deck.pptx", "application/vnd.ms-powerpoint"))).toBe("PowerPoint presentation");
    expect(fileKindLabel(item("manual.pdf", "application/pdf"))).toBe("PDF document");
    expect(fileKindLabel(item("Sheet", "application/vnd.google-apps.spreadsheet"))).toBe("Google Sheets");
    expect(fileKindLabel(item("notes.txt", "text/plain"))).toBe("Text file");
    expect(fileKindLabel(item("photo.png", "image/png"))).toBe("Image");
    expect(fileKindLabel(item("clip.mp4", "video/mp4"))).toBe("Video");
    expect(fileKindLabel(item("thing.bin", "application/octet-stream"))).toBe("File");
  });
});
