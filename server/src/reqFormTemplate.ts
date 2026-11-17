// Generic requisition form (template note): the bare template
// ships NO official form — the original app filled an
// organisation's official requisition PDF, which is not part of
// this template. Instead buildReqFormPdf draws a plain, generic
// requisition form from scratch with pdf-lib: title, header
// fields (Division, Business, Date, Prepared by, Approved by),
// a 20-line item table (Item / Description, Qty, Unit, Item #),
// page numbers ("Page X of Y"), and two signature boxes the
// typed initials are drawn into.
//
// The form stays fillable on purpose: every field name is unique
// per page (page 2+ fields carry a "_p2", "_p3", … suffix), so the
// downloaded form can be filled in further in any PDF reader and
// read back by the requisition-form scan (which reads the same
// field names, page by page). Nothing here is flattened.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** Item rows on one page of the requisition form. */
const LINES_PER_PAGE = 20;

/** pdf-lib draws with Helvetica (WinAnsi), so characters outside
    that encoding are dropped rather than failing the whole form.
    Latin-1 plus the common typographic punctuation WinAnsi also
    carries are kept. */
function safeText(value: string): string {
  const extra = new Set([
    0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0x2022,
    0x20ac, 0x2122,
  ]);
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff || extra.has(code)) out += ch;
  }
  return out;
}

export async function buildReqFormPdf(args: {
  division: string;
  businessName: string;
  date: string;
  preparerName: string;
  approverName: string;
  /** Transparent PNG (base64) of the preparer's typed initials in
      cursive, for the form's preparer signature box; null = unsigned. */
  preparerSignaturePng: string | null;
  /** Same, for the approver's signature box. */
  approverSignaturePng: string | null;
  lines: {
    name: string;
    materialNo: string | null;
    qty: number;
    unit: string;
  }[];
}): Promise<{ base64: string; pageCount: number }> {
  const pageCount = Math.max(
    1,
    Math.ceil(args.lines.length / LINES_PER_PAGE),
  );
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const form = out.getForm();

  const pageW = 612;
  const pageH = 792;
  const m = 48;
  const colW = 240;
  const rightX = pageW - m - colW;

  for (let p = 0; p < pageCount; p++) {
    const page = out.addPage([pageW, pageH]);
    const suffix = p === 0 ? "" : `_p${p + 1}`;

    // Title + page number.
    page.drawText("REQUISITION", {
      x: m,
      y: pageH - m - 18,
      size: 18,
      font: bold,
    });
    page.drawText(`Page ${p + 1} of ${pageCount}`, {
      x: pageW - m - 90,
      y: pageH - m - 14,
      size: 10,
      font,
    });
    page.drawText(safeText(args.businessName), {
      x: m,
      y: pageH - m - 44,
      size: 13,
      font: bold,
    });

    // Header fields: label above each fillable box.
    const headerField = (
      label: string,
      name: string,
      value: string,
      x: number,
      labelY: number,
    ) => {
      page.drawText(label, { x, y: labelY, size: 9, font: bold });
      const field = form.createTextField(name);
      field.addToPage(page, {
        x,
        y: labelY - 22,
        width: colW,
        height: 18,
        borderWidth: 1,
      });
      field.setText(safeText(value));
    };
    headerField("Division", "Division", args.division, m, 676);
    headerField("Date", "Date", args.date, rightX, 676);
    headerField("Business", "Business", args.businessName, m, 640);
    headerField(
      "Prepared by",
      "Prepared by",
      args.preparerName,
      rightX,
      640,
    );
    headerField(
      "Approved by",
      "Approved by",
      args.approverName,
      m,
      604,
    );

    // Item table header + one fillable row per line.
    const tableTop = 556;
    page.drawText("Item / Description", { x: m, y: tableTop, size: 10, font: bold });
    page.drawText("Qty", { x: 352, y: tableTop, size: 10, font: bold });
    page.drawText("Unit", { x: 406, y: tableTop, size: 10, font: bold });
    page.drawText("Item #", { x: 480, y: tableTop, size: 10, font: bold });
    page.drawLine({
      start: { x: m, y: tableTop - 6 },
      end: { x: pageW - m, y: tableTop - 6 },
      thickness: 1,
      color: rgb(0, 0, 0),
    });
    const slice = args.lines.slice(
      p * LINES_PER_PAGE,
      (p + 1) * LINES_PER_PAGE,
    );
    slice.forEach((line, i) => {
      const n = i + 1;
      const rowY = tableTop - 12 - n * 20;
      const rowField = (
        name: string,
        value: string,
        x: number,
        width: number,
      ) => {
        const field = form.createTextField(name);
        field.addToPage(page, {
          x,
          y: rowY,
          width,
          height: 18,
          borderWidth: 1,
        });
        field.setText(safeText(value));
      };
      rowField(`${n}${suffix}`, line.name, m, 296);
      rowField(`Qty${n}${suffix}`, String(line.qty), 352, 46);
      rowField(`Unit${n}${suffix}`, line.unit, 406, 66);
      if (line.materialNo) {
        rowField(`Material ${n}${suffix}`, line.materialNo, 480, 84);
      } else {
        rowField(`Material ${n}${suffix}`, "", 480, 84);
      }
    });

    // Signature boxes: labels above bordered boxes; the typed
    // initials are drawn inside, fitted well within the box.
    const sigBox = (
      label: string,
      x: number,
    ): [number, number, number, number] => {
      page.drawText(label, { x, y: 132, size: 9, font: bold });
      const rect: [number, number, number, number] = [x, 88, x + 240, 126];
      page.drawRectangle({
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
        borderWidth: 1,
        borderColor: rgb(0, 0, 0),
      });
      return rect;
    };
    const preparerRect = sigBox("Preparer signature", m);
    const approverRect = sigBox("Approver signature", rightX);
    page.drawText("Generated by HitBit — verify quantities before sending.", {
      x: m,
      y: 64,
      size: 8,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });

    const drawSignature = async (
      pngBase64: string | null,
      rect: [number, number, number, number],
    ) => {
      if (!pngBase64) return;
      try {
        const img = await out.embedPng(Buffer.from(pngBase64, "base64"));
        const [x1, y1, x2, y2] = rect;
        const boxW = x2 - x1;
        const boxH = y2 - y1;
        // Fit the lettering well inside the box, not edge to
        // edge: the cursive's tall swashes read as overflowing
        // when the image spans nearly the whole box height, so
        // the signature is drawn at about two-thirds of the box
        // height with clear margins on every side.
        const scale = Math.min(
          (boxW - 48) / img.width,
          (boxH * 0.66) / img.height,
        );
        if (!(scale > 0)) return;
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, {
          x: x1 + 12,
          y: y1 + (boxH - h) / 2,
          width: w,
          height: h,
        });
      } catch {
        // Unreadable signature image — leave the box blank.
      }
    };
    await drawSignature(args.preparerSignaturePng, preparerRect);
    await drawSignature(args.approverSignaturePng, approverRect);
  }

  form.updateFieldAppearances(font);
  const bytes = await out.save();
  return { base64: Buffer.from(bytes).toString("base64"), pageCount };
}
