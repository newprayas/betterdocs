/**
 * Response Formatter Service
 * Uses LLM to convert paragraph-style responses to bullet point format while preserving citations
 */

import { groqService } from '../groq/groqService';
import type { AppSettings } from '@/types/settings';
import { IndentationAnalyzer } from '@/utils/indentationAnalyzer';

export interface FormattedSection {
  title: string;
  bulletPoints: string[];
  citations: number[];
}

export class ResponseFormatter {
  /**
   * Convert paragraph response to bullet point format using LLM
   * Preserves citations and moves them to end of bullet points
   */
  static async formatToBulletPoints(
    response: string,
    settings: AppSettings
  ): Promise<string> {
    const timestamp = new Date().toISOString();
    console.log(`\n=== [${timestamp}] [INDENTATION DEBUG] LLM RESPONSE FORMATTER START ===`);
    console.log(`[${timestamp}] [INDENTATION DEBUG] ORIGINAL RESPONSE:`, response.substring(0, 200) + (response.length > 200 ? '...' : ''));
    console.log(`[${timestamp}] [INDENTATION DEBUG] ORIGINAL LENGTH:`, `${response.length} characters`);

    // Analyze original response for indentation patterns
    console.log(`[${timestamp}] [INDENTATION DEBUG] ANALYZING ORIGINAL RESPONSE STRUCTURE:`);
    IndentationAnalyzer.logMarkdownStructure(response);
    const originalAnalysis = IndentationAnalyzer.analyzeIndentation(response);
    console.log(`[${timestamp}] [INDENTATION DEBUG] ORIGINAL RESPONSE HAS NESTED STRUCTURES:`, originalAnalysis.hasNestedStructures);

    if (!response || response.trim().length === 0) {
      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTING SKIPPED:`, 'Empty response, returning as-is');
      console.log(`=== [${timestamp}] [INDENTATION DEBUG] LLM RESPONSE FORMATTER END ===\n`);
      return response;
    }

    // Use Groq API key for formatting (since we're using Groq for formatting)
    const formattingApiKey = settings.groqApiKey;

    console.log(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTER:`, 'Using Groq API key for formatting:', settings.groqApiKey ? `YES (${settings.groqApiKey.substring(0, 10)}...)` : 'NO');

    if (!formattingApiKey) {
      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTING SKIPPED:`, 'No Groq API key available, returning original response');
      console.log(`=== [${timestamp}] [INDENTATION DEBUG] LLM RESPONSE FORMATTER END ===\n`);
      return response;
    }

    try {
      console.log(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTING:`, 'Using LLM to convert to bullet points...');
      console.log(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTING:`, `Calling Groq service for formatting`);

      const formattingPrompt = this.buildFormattingPrompt(response);
      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTING PROMPT:`, formattingPrompt.substring(0, 300) + '...');
      console.log(`[${timestamp}] [INDENTATION DEBUG] PROMPT ANALYSIS:`, {
        promptLength: formattingPrompt.length,
        containsNestedInstructions: formattingPrompt.includes('NESTED'),
        containsIndentInstructions: formattingPrompt.includes('indent'),
        containsBulletInstructions: formattingPrompt.includes('*'),
        containsExampleFormatting: formattingPrompt.includes('EXAMPLE TRANSFORMATION')
      });

      const formattedResponse = await groqService.generateResponse(
        formattingPrompt,
        "You are a response formatting specialist.",
        settings.groqModel || 'llama-3.3-70b-versatile',
        {
          temperature: 0.3, // Lower temperature for consistent formatting
          maxTokens: Math.min(response.length * 2, 4000), // Allow for expansion but cap it
        }
      );

      console.log(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTING:`, 'Groq service response received, length:', formattedResponse.length);

      // Comprehensive analysis of formatted response
      console.log(`[${timestamp}] [INDENTATION DEBUG] ANALYZING FORMATTED RESPONSE STRUCTURE:`);
      IndentationAnalyzer.logMarkdownStructure(formattedResponse);
      const formattedAnalysis = IndentationAnalyzer.analyzeIndentation(formattedResponse);

      // Check for nested structures detection
      const hasNestedStructures = IndentationAnalyzer.detectNestedLists(formattedResponse);
      console.log(`[${timestamp}] [INDENTATION DEBUG] NESTED STRUCTURES DETECTED IN FORMATTED RESPONSE:`, hasNestedStructures);

      // Create visualization of indentation
      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTED RESPONSE INDENTATION VISUALIZATION:`);
      IndentationAnalyzer.visualizeIndentation(formattedResponse);

      // Additional detailed analysis
      const hasNewlines = formattedResponse.includes('\n');
      const bulletCount = (formattedResponse.match(/^\* /gm) || []).length;
      const newlineCount = (formattedResponse.match(/\n/g) || []).length;
      const nestedBulletCount = (formattedResponse.match(/^[ \t]+\* /gm) || []).length;

      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTING ANALYSIS:`, {
        hasNewlines,
        bulletCount,
        newlineCount,
        nestedBulletCount,
        firstBulletIndex: formattedResponse.indexOf('* '),
        containsListMarkers: formattedResponse.includes('* '),
        startsWithBullet: formattedResponse.trim().startsWith('* '),
        hasIndentation: formattedAnalysis.indentedLines > 0,
        maxIndentLevel: formattedAnalysis.maxIndentLevel,
        responsePreview: formattedResponse.substring(0, 300) + (formattedResponse.length > 300 ? '...' : ''),
        rawCharCodes: Array.from(formattedResponse.substring(0, 100)).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')
      });

      // Compare original vs formatted
      console.log(`[${timestamp}] [INDENTATION DEBUG] ORIGINAL vs FORMATTED COMPARISON:`, {
        originalHadNested: originalAnalysis.hasNestedStructures,
        formattedHasNested: formattedAnalysis.hasNestedStructures,
        originalIndentedLines: originalAnalysis.indentedLines,
        formattedIndentedLines: formattedAnalysis.indentedLines,
        originalMaxIndent: originalAnalysis.maxIndentLevel,
        formattedMaxIndent: formattedAnalysis.maxIndentLevel,
        improvement: formattedAnalysis.maxIndentLevel > originalAnalysis.maxIndentLevel ? 'YES - Added nesting' : 'NO - No improvement'
      });

      console.log(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTING COMPLETE:`, `Formatted response: ${formattedResponse.length} characters`);
      console.log(`[${timestamp}] [INDENTATION DEBUG] FORMATTED PREVIEW:`, formattedResponse.substring(0, 200) + (formattedResponse.length > 200 ? '...' : ''));
      console.log(`=== [${timestamp}] [INDENTATION DEBUG] LLM RESPONSE FORMATTER END ===\n`);

      return formattedResponse;

    } catch (error) {
      console.error(`[${timestamp}] [INDENTATION DEBUG] LLM FORMATTING ERROR:`, 'Failed to format with LLM:', error);
      console.log(`[${timestamp}] [INDENTATION DEBUG] FALLBACK:`, 'Returning original response due to formatting error');
      console.log(`=== [${timestamp}] [INDENTATION DEBUG] LLM RESPONSE FORMATTER END ===\n`);
      return response;
    }
  }

  /**
   * Build the formatting prompt for the LLM
   */
  private static buildFormattingPrompt(response: string): string {
    return `You are a response formatting specialist. Your task is to organize the response into a clear, readable format using Headers, Paragraphs, and Bullet Points while preserving all citations and DETAILED EXPLANATIONS.

CRITICAL FORMATTING RULES:
1. **Structure**: Use a mix of:
   - ✅ **Bold Headers** for main sections (Start with ✅ emoji)
   - **Paragraphs** for detailed explanations, concepts, and descriptions.
   - **Bullet Points** strictly for lists (e.g., list of symptoms, types, causes).
2. **Preserve Depth**: Do NOT convert detailed paragraph explanations into simple bullet points if it causes loss of detail. Keep the prose.
3. **Citations**: Preserve ALL citations [1], [2] in their original positions.
4. **Headers**: Start EVERY section header with ✅ emoji followed by bold text. Format: ✅ **Section Title:**
5. **No Changes**: Do not add, remove, or change any factual information. Only improve the layout.

EXAMPLE TRANSFORMATION:

INPUT:
"Surgical management includes early surgery. Early surgery within 2 weeks involving limbal stem cell transplantation [1] is crucial because it prevents scarring. Amniotic membrane grafts [2] are also distinct. Late surgery after 6 months involves symblepharon release [3]."

OUTPUT:
✅ **Surgical Management:**

**Early Surgery (within 2 weeks):**
Early surgery is crucial because it prevents scarring. Procedures include:
* Limbal stem cell transplantation [1]
* Amniotic membrane grafts [2]

**Late Surgery (after 6 months):**
Interventions typically involve symblepharon release [3].

YOUR TASK:
Format the following response to be readable and structured, preserving all depth and details:

${response}`;
  }

  /**
   * Legacy rule-based method (kept as fallback)
   */
  static async formatToBulletPointsLegacy(response: string): Promise<string> {
    console.log('[LEGACY FORMATTING]', 'Using rule-based formatting as fallback');

    if (!response || response.trim().length === 0) {
      return response;
    }

    // Extract all citations first to preserve them
    const citations = this.extractCitations(response);
    const responseWithoutCitations = this.removeCitations(response);

    // Split response into logical sections
    const sections = this.identifySections(responseWithoutCitations);

    // Format each section with bullet points
    const formattedSections = sections.map(section =>
      this.formatSection(section, citations)
    );

    // Combine all sections
    return formattedSections.join('\n\n');
  }

  /**
   * Extract citation references from text
   */
  private static extractCitations(text: string): Array<{ index: number, position: number }> {
    const citationPattern = /\[(\d+)\]/g;
    const citations: Array<{ index: number, position: number }> = [];
    let match;

    while ((match = citationPattern.exec(text)) !== null) {
      citations.push({
        index: parseInt(match[1], 10),
        position: match.index
      });
    }

    return citations;
  }

  /**
   * Remove citations from text for processing
   */
  private static removeCitations(text: string): string {
    return text.replace(/\[\d+\]/g, '');
  }

  /**
   * Identify logical sections in the response
   */
  private static identifySections(text: string): Array<{ title: string, content: string }> {
    console.log('[SECTION ANALYSIS]', `Analyzing text of ${text.length} characters`);
    const sections: Array<{ title: string, content: string }> = [];

    // Split by double newlines or major sentence breaks
    const paragraphs = text.split(/\n\s*\n/);
    console.log('[PARAGRAPH SPLIT]', `Found ${paragraphs.length} paragraphs`);

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const trimmed = paragraph.trim();
      if (trimmed.length === 0) {
        console.log(`[PARAGRAPH ${i}]`, 'Empty paragraph, skipping');
        continue;
      }

      console.log(`[PARAGRAPH ${i}]`, `Content: "${trimmed.substring(0, 80)}${trimmed.length > 80 ? '...' : ''}"`);

      // Check if this looks like a header or main topic
      const isHeader = this.isHeader(trimmed);
      console.log(`[PARAGRAPH ${i}]`, `Is header: ${isHeader}`);

      if (isHeader || sections.length === 0) {
        const title = isHeader ? this.cleanHeader(trimmed) : 'Main Points';
        const content = isHeader ? '' : trimmed;
        sections.push({ title, content });
        console.log(`[SECTION CREATED]`, `Title: "${title}", Content length: ${content.length}`);
      } else {
        // Add to last section
        const lastSection = sections[sections.length - 1];
        lastSection.content += (lastSection.content ? ' ' : '') + trimmed;
        console.log(`[SECTION UPDATED]`, `Added to "${lastSection.title}", new length: ${lastSection.content.length}`);
      }
    }

    console.log('[SECTION ANALYSIS COMPLETE]', `Created ${sections.length} sections`);
    return sections;
  }

  /**
   * Check if text looks like a header
   */
  private static isHeader(text: string): boolean {
    // Headers are typically shorter, may end with colon, or contain keywords
    const headerKeywords = [
      'criteria', 'factors', 'features', 'symptoms', 'treatment',
      'diagnosis', 'management', 'assessment', 'findings', 'results'
    ];

    const isShort = text.length < 100;
    const endsWithColon = text.trim().endsWith(':');
    const hasKeyword = headerKeywords.some(keyword =>
      text.toLowerCase().includes(keyword)
    );

    return isShort && (endsWithColon || hasKeyword);
  }

  /**
   * Clean header text
   */
  private static cleanHeader(header: string): string {
    return header
      .replace(/[:：]$/, '') // Remove trailing colons
      .replace(/^\*\s*/, '') // Remove leading bullets
      .trim();
  }

  /**
   * Format a section into bullet points with citations
   */
  private static formatSection(
    section: { title: string, content: string },
    citations: Array<{ index: number, position: number }>
  ): string {
    console.log(`[SECTION FORMATTING]`, `Formatting section: "${section.title}" with ${section.content.length} chars`);

    const bulletPoints = this.createBulletPoints(section.content);
    console.log(`[SECTION FORMATTING]`, `Created ${bulletPoints.length} bullet points for section`);

    // Add citations to bullet points
    const bulletPointsWithCitations = bulletPoints.map((point, index) => {
      const pointCitations = this.getCitationsForPoint(point, section.content, citations);
      console.log(`[BULLET ${index + 1}]`, `Point: "${point.substring(0, 60)}${point.length > 60 ? '...' : ''}"`);
      console.log(`[BULLET ${index + 1}]`, `Citations found: ${pointCitations.length > 0 ? pointCitations.map(c => `[${c}]`).join(', ') : 'None'}`);

      const citationText = pointCitations.length > 0
        ? ' ' + pointCitations.map(c => `[${c}]`).join(', ')
        : '';
      return `* ${point}${citationText}`;
    });

    // Format section
    let formatted = `**${section.title}:**\n`;
    formatted += bulletPointsWithCitations.join('\n');

    console.log(`[SECTION FORMATTED]`, `Section formatted with ${bulletPointsWithCitations.length} bullet points`);
    return formatted;
  }

  /**
   * Create bullet points from content
   */
  private static createBulletPoints(content: string): string[] {
    console.log('[BULLET CREATION]', `Creating bullet points from ${content.length} characters of content`);

    // Split by sentences or logical clauses
    const sentences = this.splitIntoSentences(content);
    console.log('[SENTENCE SPLIT]', `Found ${sentences.length} sentences:`, sentences.map((s, i) => `${i + 1}. "${s.substring(0, 50)}${s.length > 50 ? '...' : ''}"`));

    const bulletPoints: string[] = [];
    let currentPoint = '';

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const trimmed = sentence.trim();
      if (trimmed.length === 0) {
        console.log(`[SENTENCE ${i}]`, 'Empty sentence, skipping');
        continue;
      }

      console.log(`[SENTENCE ${i}]`, `Processing: "${trimmed}"`);

      // If adding this sentence makes the point too long, start a new point
      if (currentPoint && currentPoint.length + trimmed.length > 200) {
        bulletPoints.push(currentPoint.trim());
        console.log(`[BULLET CREATED]`, `Bullet ${bulletPoints.length}: "${currentPoint.trim()}"`);
        currentPoint = trimmed;
      } else {
        currentPoint += (currentPoint ? ' ' : '') + trimmed;
        console.log(`[BULLET BUILDING]`, `Current point length: ${currentPoint.length}`);
      }
    }

    if (currentPoint.trim()) {
      bulletPoints.push(currentPoint.trim());
      console.log(`[FINAL BULLET]`, `Final bullet: "${currentPoint.trim()}"`);
    }

    console.log('[BULLET CREATION COMPLETE]', `Created ${bulletPoints.length} bullet points`);
    return bulletPoints;
  }

  /**
   * Split text into sentences
   */
  private static splitIntoSentences(text: string): string[] {
    // Split by sentence-ending punctuation but preserve newlines for list formatting
    return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  }

  /**
   * Get citations that belong to a specific bullet point
   */
  private static getCitationsForPoint(
    point: string,
    originalContent: string,
    citations: Array<{ index: number, position: number }>
  ): number[] {
    // Find citations that appear within the range of this point in original content
    const pointStart = originalContent.indexOf(point);
    const pointEnd = pointStart + point.length;

    return citations
      .filter(cit => cit.position >= pointStart && cit.position < pointEnd)
      .map(cit => cit.index)
      .filter((index, pos, arr) => arr.indexOf(index) === pos); // Remove duplicates
  }
}