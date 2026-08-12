import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function issueNumber(value) {
  return String(value || "2").replace(/[^\d]/g, "") || "2";
}

function textXRightAligned(font, text, size, rightX) {
  return rightX - font.widthOfTextAtSize(text, size);
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const issue = issueNumber(url.searchParams.get("issue"));
    const sourcePath = path.join(process.cwd(), "public", "reports", "latest_report.pdf");
    const fontPath = path.join(process.cwd(), "assets", "fonts", "NOTOSANSKR-VF.TTF");
    const [sourceBytes, fontBytes] = await Promise.all([fs.readFile(sourcePath), fs.readFile(fontPath)]);

    const pdf = await PDFDocument.load(sourceBytes);
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fontBytes, { subset: true });
    const pages = pdf.getPages();
    const navy = rgb(0x12 / 255, 0x28 / 255, 0x44 / 255);
    const muted = rgb(0x85 / 255, 0x91 / 255, 0xa3 / 255);
    const footerBg = rgb(0xef / 255, 0xf4 / 255, 0xf8 / 255);
    const issueText = `Issue ${issue}`;

    if (pages[0]) {
      const { width, height } = pages[0].getSize();
      pages[0].drawRectangle({
        x: width - 166,
        y: height - 68,
        width: 124,
        height: 30,
        color: navy,
      });
      pages[0].drawText(issueText, {
        x: textXRightAligned(font, issueText, 18, width - 42),
        y: height - 58,
        size: 18,
        font,
        color: rgb(1, 1, 1),
      });
    }

    for (const page of pages.slice(1)) {
      page.drawRectangle({
        x: 38,
        y: 8,
        width: 312,
        height: 18,
        color: footerBg,
      });
      page.drawText(`Invest KOREA · 타겟기업 글로벌 투자시그널 모니터링 · ${issueText}`, {
        x: 42,
        y: 16,
        size: 8,
        font,
        color: muted,
      });
    }

    const output = await pdf.save();
    return new Response(output, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="global-signal-monitor-issue-${issue}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
