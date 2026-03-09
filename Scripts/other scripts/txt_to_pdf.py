#!/usr/bin/env python3
"""
Convert a DOCX file in the current working directory to PDF.
"""

from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from docx import Document

INPUT_BASENAME = "COMBINED_NOTES.docx"
OUTPUT_BASENAME = "COMBINED_NOTES.pdf"

def main():
    root_dir = Path.cwd()
    input_file = root_dir / INPUT_BASENAME
    output_file = root_dir / OUTPUT_BASENAME

    if not input_file.exists():
        print(f"Input DOCX not found: {input_file}")
        return

    pdf_doc = SimpleDocTemplate(
        str(output_file),
        pagesize=A4,
        rightMargin=50,
        leftMargin=50,
        topMargin=50,
        bottomMargin=50,
    )

    styles = getSampleStyleSheet()

    file_header = ParagraphStyle(
        'FileHeader',
        parent=styles['Heading2'],
        fontSize=12,
        textColor='black',
        spaceAfter=12,
        allowWidows=1,
        allowOrphans=1
    )
    
    separator = ParagraphStyle(
        'Separator',
        parent=styles['Normal'],
        fontSize=8,
        textColor='gray',
        spaceAfter=6
    )
    
    body_text = ParagraphStyle(
        'BodyText',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        spaceAfter=3,
        allowWidows=1,
        allowOrphans=1
    )
    
    story = []
    source_doc = Document(input_file)

    for para in source_doc.paragraphs:
        line = para.text.strip()

        if not line:
            story.append(Spacer(1, 4))
        elif line.startswith("FILE:"):
            story.append(Paragraph(line.replace("FILE: ", "<b>File: </b>"), file_header))
        else:
            safe_line = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            story.append(Paragraph(safe_line, body_text))

        if line.startswith("FILE:"):
            story.append(Paragraph("-" * 64, separator))

    pdf_doc.build(story)
    print(f"Done. PDF created: {output_file}")

if __name__ == "__main__":
    main()
