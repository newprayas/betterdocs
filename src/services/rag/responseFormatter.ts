/**
 * Response Formatter Service
 * Uses LLM to convert paragraph-style responses to bullet point format while preserving citations
 */

import { GeminiService } from '../gemini/geminiService';
import type { AppSettings } from '@/types/settings';

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
    console.log('\n=== LLM RESPONSE FORMATTER START ===');
    console.log('[ORIGINAL RESPONSE]', response.substring(0, 200) + (response.length > 200 ? '...' : ''));
    console.log('[ORIGINAL LENGTH]', `${response.length} characters`);
    
    if (!response || response.trim().length === 0) {
      console.log('[FORMATTING SKIPPED]', 'Empty response, returning as-is');
      console.log('=== LLM RESPONSE FORMATTER END ===\n');
      return response;
    }

    // Use main API key for formatting
    const formattingApiKey = settings.geminiApiKey;
    
    console.log('[LLM FORMATTER] Using main API key for formatting:', settings.geminiApiKey ? `YES (${settings.geminiApiKey.substring(0, 10)}...)` : 'NO');
    
    if (!formattingApiKey) {
      console.log('[FORMATTING SKIPPED]', 'No API key available, returning original response');
      console.log('=== LLM RESPONSE FORMATTER END ===\n');
      return response;
    }

    try {
      console.log('[LLM FORMATTING]', 'Using LLM to convert to bullet points...');
      console.log('[LLM FORMATTING]', `Calling Gemini service with main API key`);
      
      const formattingPrompt = this.buildFormattingPrompt(response);
      console.log('[FORMATTING PROMPT]', formattingPrompt.substring(0, 300) + '...');
      
      // Create a separate instance for formatting to avoid conflicts
      const formattingGeminiService = new GeminiService();
      formattingGeminiService.initialize(formattingApiKey, 'gemini-2.5-flash-lite');
      
      const formattedResponse = await formattingGeminiService.generateResponse(
        formattingPrompt,
        '', // No context needed for formatting
        '', // No system prompt needed for formatting
        {
          temperature: 0.3, // Lower temperature for consistent formatting
          maxTokens: Math.min(response.length * 2, 4000), // Allow for expansion but cap it
        }
      );
      
      console.log('[LLM FORMATTING]', 'Gemini service response received, length:', formattedResponse.length);
      
      // DEBUG: Check for newlines and bullet points in the formatted response
      const hasNewlines = formattedResponse.includes('\n');
      const bulletCount = (formattedResponse.match(/^\* /gm) || []).length;
      const newlineCount = (formattedResponse.match(/\n/g) || []).length;
      
      console.log('[FORMATTING ANALYSIS]', {
        hasNewlines,
        bulletCount,
        newlineCount,
        firstBulletIndex: formattedResponse.indexOf('* '),
        containsListMarkers: formattedResponse.includes('* '),
        startsWithBullet: formattedResponse.trim().startsWith('* '),
        responsePreview: formattedResponse.substring(0, 300) + (formattedResponse.length > 300 ? '...' : ''),
        rawCharCodes: Array.from(formattedResponse.substring(0, 100)).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')
      });
      
      console.log('[LLM FORMATTING COMPLETE]', `Formatted response: ${formattedResponse.length} characters`);
      console.log('[FORMATTED PREVIEW]', formattedResponse.substring(0, 200) + (formattedResponse.length > 200 ? '...' : ''));
      console.log('=== LLM RESPONSE FORMATTER END ===\n');
      
      return formattedResponse;
      
    } catch (error) {
      console.error('[LLM FORMATTING ERROR]', 'Failed to format with LLM:', error);
      console.log('[FALLBACK]', 'Returning original response due to formatting error');
      console.log('=== LLM RESPONSE FORMATTER END ===\n');
      return response;
    }
  }

  /**
   * Build the formatting prompt for the LLM
   */
  private static buildFormattingPrompt(response: string): string {
    return `You are a response formatting specialist. Your task is to convert paragraph-style responses to clear, structured bullet point format while preserving all citations.

CRITICAL FORMATTING RULES:
1. Convert paragraphs to bullet points using this format: * [bullet point text]
2. Preserve ALL citations in their original positions relative to the information they support
3. Move citations to the END of bullet points when they appear within the bullet text
4. Maintain Vancouver citation style: [1], [2], [3] etc.
5. Create logical section headers using bold format with checkmark emoji: ✅ **[Section Title]:**
6. Keep the same information and meaning - just change the format
7. Do not add, remove, or change any factual information
8. Do not invent new citations or modify existing citation numbers

EXAMPLE TRANSFORMATION:

INPUT:
"The CURB-65 criteria is used to assess the severity of CAP [1]. One point is scored for each of the following features: confusion (mini mental score of 8 or less or new disorientation in person, place, or time), urea of >7 mmol/L or >20 mg/dl, respiratory rate of ≥30/min, blood pressure (systolic BP <90 mmHg and diastolic BP ≤60 mmHg), and age ≥65 years [1]. The CURB-65 score is used for the management of CAP [1]. A score of 0 or 1 indicates home treatment, a score of 2 suggests hospitalization, and a score of 3 or more requires management in a hospital, potentially including the ICU, especially if the score is 4 or 5 [1]."

OUTPUT:
✅ **CURB-65 Criteria for Assessing CAP Severity:**
* The CURB-65 criteria is used to assess the severity of CAP [1]
* One point is scored for each of the following features:
    * Confusion (mini mental score of 8 or less or new disorientation in person, place, or time)
    * Urea of >7 mmol/L or >20 mg/dl
    * Respiratory rate of ≥30/min
    * Blood pressure (systolic BP <90 mmHg and diastolic BP ≤60 mmHg)
    * Age ≥65 years [1]

✅ **Management Based on CURB-65 Score:**
* The CURB-65 score is used for the management of CAP [1]
* A score of 0 or 1 indicates home treatment
* A score of 2 suggests hospitalization
* A score of 3 or more requires management in a hospital, potentially including the ICU, especially if the score is 4 or 5 [1]

YOUR TASK:
Convert the following response to bullet point format following the rules above:

${response}

Remember: Preserve all citations exactly as they appear, just reposition them to the end of bullet points when appropriate.`;
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
  private static extractCitations(text: string): Array<{index: number, position: number}> {
    const citationPattern = /\[(\d+)\]/g;
    const citations: Array<{index: number, position: number}> = [];
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
  private static identifySections(text: string): Array<{title: string, content: string}> {
    console.log('[SECTION ANALYSIS]', `Analyzing text of ${text.length} characters`);
    const sections: Array<{title: string, content: string}> = [];
    
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
    section: {title: string, content: string}, 
    citations: Array<{index: number, position: number}>
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
    let formatted = `✅ **${section.title}:**\n`;
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
    citations: Array<{index: number, position: number}>
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