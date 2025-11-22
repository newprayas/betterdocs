// Comprehensive debugging script for the document upload issue
// Run this in browser console after uploading a JSON file

async function debugUploadIssue() {
  console.log('🔍 COMPREHENSIVE UPLOAD ISSUE DEBUG');
  console.log('=====================================');
  
  try {
    // Get database instance
    const db = window.db;
    if (!db) {
      console.error('❌ Database not available');
      return;
    }
    
    console.log('✅ Database accessed successfully');
    
    // Get all documents
    const allDocuments = await db.documents.toArray();
    console.log('📄 ALL DOCUMENTS IN DATABASE:', {
      count: allDocuments.length,
      documents: allDocuments.map(doc => ({
        id: doc.id,
        sessionId: doc.sessionId,
        filename: doc.filename,
        status: doc.status,
        enabled: doc.enabled,
        createdAt: doc.createdAt,
        processedAt: doc.processedAt
      }))
    });
    
    // Get all embeddings
    const allEmbeddings = await db.embeddings.toArray();
    console.log('🔗 ALL EMBEDDINGS IN DATABASE:', {
      count: allEmbeddings.length,
      uniqueDocumentIds: [...new Set(allEmbeddings.map(e => e.documentId))],
      uniqueSessionIds: [...new Set(allEmbeddings.map(e => e.sessionId))]
    });
    
    // Check for session ID mismatches
    const documentSessionIds = allDocuments.map(d => d.sessionId);
    const embeddingSessionIds = [...new Set(allEmbeddings.map(e => e.sessionId))];
    
    console.log('🔍 SESSION ID ANALYSIS:', {
      documentSessionIds,
      embeddingSessionIds,
      sessionMismatch: documentSessionIds.some(id => !embeddingSessionIds.includes(id)),
      orphanedEmbeddings: embeddingSessionIds.some(id => !documentSessionIds.includes(id))
    });
    
    // Check for orphaned embeddings
    const documentIds = new Set(allDocuments.map(doc => doc.id));
    const orphanedEmbeddings = allEmbeddings.filter(embedding => !documentIds.has(embedding.documentId));
    
    if (orphanedEmbeddings.length > 0) {
      console.warn('🚨 ORPHANED EMBEDDINGS FOUND:', {
        count: orphanedEmbeddings.length,
        embeddings: orphanedEmbeddings.map(e => ({
          id: e.id,
          documentId: e.documentId,
          sessionId: e.sessionId,
          content: e.content.substring(0, 100) + '...'
        }))
      });
    } else {
      console.log('✅ No orphaned embeddings found');
    }
    
    // Test query by session ID for each document
    console.log('🔍 TESTING SESSION QUERIES:');
    for (const doc of allDocuments) {
      console.log(`\n📋 Testing document: ${doc.filename} (ID: ${doc.id}, Session: ${doc.sessionId})`);
      
      // Query by session ID
      const sessionDocs = await db.documents
        .where('sessionId')
        .equals(doc.sessionId)
        .toArray();
      
      console.log(`  Session query result: ${sessionDocs.length} documents`);
      sessionDocs.forEach((sessionDoc, index) => {
        console.log(`    ${index + 1}. ID: ${sessionDoc.id}, Filename: ${sessionDoc.filename}, Status: ${sessionDoc.status}`);
      });
      
      // Check if our document is in the results
      const foundInSession = sessionDocs.some(d => d.id === doc.id);
      console.log(`  Document found in session query: ${foundInSession ? '✅ YES' : '❌ NO'}`);
      
      if (!foundInSession) {
        console.error('🚨 CRITICAL ISSUE: Document exists but not found by session query!');
        console.error('  Document details:', {
          id: doc.id,
          sessionId: doc.sessionId,
          filename: doc.filename
        });
        
        // Try to understand why the query fails
        console.log('  Debugging session query...');
        
        // Check if there are any session ID type issues
        console.log('  Session ID type:', typeof doc.sessionId);
        console.log('  Session ID value:', doc.sessionId);
        console.log('  Session ID length:', doc.sessionId?.length);
        
        // Try exact match comparison
        const allSessionDocs = await db.documents.toArray();
        const matchingDocs = allSessionDocs.filter(d => d.sessionId === doc.sessionId);
        console.log('  Manual filter result:', matchingDocs.length);
      }
    }
    
    // Check database schema and indexes
    console.log('\n🔍 DATABASE SCHEMA ANALYSIS:');
    console.log('Documents table schema:', db.documents.schema);
    console.log('Documents table indexes:', Object.keys(db.documents.schema.idxByName));
    
    // Test a direct query with the exact session ID from a document
    if (allDocuments.length > 0) {
      const testDoc = allDocuments[0];
      const testSessionId = testDoc.sessionId;
      
      console.log(`\n🧪 DIRECT QUERY TEST with session ID: ${testSessionId}`);
      
      // Try different query approaches
      const approach1 = await db.documents.where('sessionId').equals(testSessionId).toArray();
      const approach2 = await db.documents.filter(doc => doc.sessionId === testSessionId).toArray();
      const approach3 = await db.documents.toArray().then(docs => docs.filter(doc => doc.sessionId === testSessionId));
      
      console.log('Query approach 1 (where.equals):', approach1.length);
      console.log('Query approach 2 (filter):', approach2.length);
      console.log('Query approach 3 (manual filter):', approach3.length);
      
      if (approach1.length !== approach3.length) {
        console.error('🚨 INDEXEDDB QUERY ISSUE: where() and manual filter return different results!');
      }
    }
    
    console.log('\n✅ Debug analysis complete');
    
  } catch (error) {
    console.error('❌ Error during debugging:', error);
  }
}

// Function to monitor document changes in real-time
async function monitorDocumentChanges() {
  console.log('👁️ STARTING DOCUMENT CHANGE MONITOR');
  
  const db = window.db;
  if (!db) {
    console.error('❌ Database not available');
    return;
  }
  
  // Check current state
  const initialDocs = await db.documents.toArray();
  console.log('Initial document count:', initialDocs.length);
  
  // Set up observer for changes (if supported)
  if (db.documents.hook) {
    db.documents.hook('creating', (primKey, obj, trans) => {
      console.log('📝 DOCUMENT CREATING:', { primKey, obj });
    });
    
    db.documents.hook('created', (primKey, obj, trans) => {
      console.log('✅ DOCUMENT CREATED:', { primKey, obj });
    });
    
    db.documents.hook('updating', (modifications, primKey, obj, trans) => {
      console.log('📝 DOCUMENT UPDATING:', { modifications, primKey, obj });
    });
    
    db.documents.hook('updated', (modifications, primKey, obj, trans) => {
      console.log('✅ DOCUMENT UPDATED:', { modifications, primKey, obj });
    });
  }
}

// Export functions for use in browser console
if (typeof window !== 'undefined') {
  window.debugUploadIssue = debugUploadIssue;
  window.monitorDocumentChanges = monitorDocumentChanges;
  
  console.log('🔧 Upload debug functions loaded!');
  console.log('Use debugUploadIssue() to analyze the current database state');
  console.log('Use monitorDocumentChanges() to start monitoring document changes');
}