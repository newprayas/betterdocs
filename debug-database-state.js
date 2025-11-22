// Debug script to check database state for orphaned embeddings and document issues
// Run this in the browser console to diagnose the document loss issue

async function debugDatabaseState() {
  console.log('🔍 DEBUGGING DATABASE STATE');
  console.log('================================');
  
  try {
    // Access the database directly
    const db = window.db || (await import('./src/services/indexedDB/db.js')).then(m => m.db);
    
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
        processedAt: doc.processedAt,
        createdAt: doc.createdAt
      }))
    });
    
    // Get all embeddings
    const allEmbeddings = await db.embeddings.toArray();
    console.log('🔗 ALL EMBEDDINGS IN DATABASE:', {
      count: allEmbeddings.length,
      documentIds: [...new Set(allEmbeddings.map(e => e.documentId))],
      sessionIds: [...new Set(allEmbeddings.map(e => e.sessionId))]
    });
    
    // Check for orphaned embeddings (embeddings without corresponding documents)
    const documentIds = new Set(allDocuments.map(doc => doc.id));
    const orphanedEmbeddings = allEmbeddings.filter(embedding => !documentIds.has(embedding.documentId));
    
    console.log('🚨 ORPHANED EMBEDDINGS:', {
      count: orphanedEmbeddings.length,
      embeddings: orphanedEmbeddings.map(e => ({
        id: e.id,
        documentId: e.documentId,
        sessionId: e.sessionId,
        content: e.content.substring(0, 100) + '...'
      }))
    });
    
    // Check for documents without embeddings
    const embeddingDocumentIds = new Set(allEmbeddings.map(e => e.documentId));
    const documentsWithoutEmbeddings = allDocuments.filter(doc => !embeddingDocumentIds.has(doc.id));
    
    console.log('📄 DOCUMENTS WITHOUT EMBEDDINGS:', {
      count: documentsWithoutEmbeddings.length,
      documents: documentsWithoutEmbeddings.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        status: doc.status,
        enabled: doc.enabled
      }))
    });
    
    // Group by session to see session-specific issues
    const sessions = [...new Set([...allDocuments.map(d => d.sessionId), ...allEmbeddings.map(e => e.sessionId)])];
    
    for (const sessionId of sessions) {
      const sessionDocuments = allDocuments.filter(d => d.sessionId === sessionId);
      const sessionEmbeddings = allEmbeddings.filter(e => e.sessionId === sessionId);
      
      console.log(`📂 SESSION ${sessionId}:`, {
        documentCount: sessionDocuments.length,
        embeddingCount: sessionEmbeddings.length,
        documents: sessionDocuments.map(d => ({
          id: d.id,
          filename: d.filename,
          status: d.status,
          enabled: d.enabled
        })),
        orphanedEmbeddings: sessionEmbeddings.filter(e => !documentIds.has(e.documentId)).length
      });
    }
    
    // Check document status distribution
    const statusCounts = allDocuments.reduce((acc, doc) => {
      acc[doc.status] = (acc[doc.status] || 0) + 1;
      return acc;
    }, {});
    
    console.log('📊 DOCUMENT STATUS DISTRIBUTION:', statusCounts);
    
    // Check enabled/disabled distribution
    const enabledCounts = allDocuments.reduce((acc, doc) => {
      const key = doc.enabled ? 'enabled' : 'disabled';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    
    console.log('📊 DOCUMENT ENABLED DISTRIBUTION:', enabledCounts);
    
    console.log('✅ Database state analysis complete');
    
  } catch (error) {
    console.error('❌ Error during database debugging:', error);
  }
}

// Function to check a specific session
async function debugSession(sessionId) {
  console.log(`🔍 DEBUGGING SESSION: ${sessionId}`);
  console.log('================================');
  
  try {
    const db = window.db || (await import('./src/services/indexedDB/db.js')).then(m => m.db);
    
    if (!db) {
      console.error('❌ Database not available');
      return;
    }
    
    const sessionDocuments = await db.documents.where('sessionId').equals(sessionId).toArray();
    const sessionEmbeddings = await db.embeddings.where('sessionId').equals(sessionId).toArray();
    
    console.log('📄 SESSION DOCUMENTS:', {
      count: sessionDocuments.length,
      documents: sessionDocuments.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        status: doc.status,
        enabled: doc.enabled,
        processedAt: doc.processedAt
      }))
    });
    
    console.log('🔗 SESSION EMBEDDINGS:', {
      count: sessionEmbeddings.length,
      documentIds: [...new Set(sessionEmbeddings.map(e => e.documentId))],
      chunks: sessionEmbeddings.map(e => ({
        id: e.id,
        documentId: e.documentId,
        chunkIndex: e.chunkIndex,
        content: e.content.substring(0, 50) + '...'
      }))
    });
    
    // Check for mismatches
    const documentIds = new Set(sessionDocuments.map(doc => doc.id));
    const orphanedEmbeddings = sessionEmbeddings.filter(e => !documentIds.has(e.documentId));
    
    if (orphanedEmbeddings.length > 0) {
      console.warn('🚨 ORPHANED EMBEDDINGS IN SESSION:', orphanedEmbeddings.length);
    }
    
  } catch (error) {
    console.error('❌ Error debugging session:', error);
  }
}

// Export functions for use in browser console
if (typeof window !== 'undefined') {
  window.debugDatabaseState = debugDatabaseState;
  window.debugSession = debugSession;
  
  console.log('🔧 Debug functions loaded!');
  console.log('Use debugDatabaseState() to check all database state');
  console.log('Use debugSession(sessionId) to check a specific session');
}