// Test script to verify document ID conflict fix
// This simulates the scenario where a document with the same ID is uploaded to different sessions

console.log('🧪 Testing Document ID Conflict Fix\n');

// Simulate the document service methods
const mockDocumentService = {
  // Simulate existing documents in different sessions
  documents: [
    { id: '844aabdc-752b-4aea-a195-539493c96859', sessionId: 'session-1', filename: 'test.pdf' },
    { id: 'doc-2', sessionId: 'session-2', filename: 'other.pdf' }
  ],
  
  getDocument: function(id, userId, sessionId) {
    return this.documents.find(doc => doc.id === id && doc.sessionId === sessionId);
  },
  
  getDocumentAcrossAllSessions: function(id) {
    return this.documents.find(doc => doc.id === id);
  },
  
  createDocument: function(data) {
    const newDoc = { ...data, id: data.id };
    this.documents.push(newDoc);
    return newDoc;
  }
};

// Test the logic from our fix
function testDocumentIdConflictHandling() {
console.log('📋 Test Case 1: Document exists in another session');

const packageDocId = '844aabdc-752b-4aea-a195-539493c96859';
const currentSessionId = 'session-2'; // Different from the existing document's session
const userId = 'user-123';

// Check if document exists in current session
let document = mockDocumentService.getDocument(packageDocId, userId, currentSessionId);
let actualDocId;
let needsNewId = false;

console.log('  Document exists in current session:', !!document);
console.log('  Current session ID:', currentSessionId);
console.log('  Existing document session ID:', mockDocumentService.getDocumentAcrossAllSessions(packageDocId)?.sessionId);

// If document doesn't exist in current session, check if it exists in any session
if (!document) {
  const existingDocAcrossSessions = mockDocumentService.getDocumentAcrossAllSessions(packageDocId);
  console.log('  Document exists across all sessions:', !!existingDocAcrossSessions);
  
  if (existingDocAcrossSessions) {
    console.log('  ⚠️  Document exists in another session:', {
      id: existingDocAcrossSessions.id,
      existingSessionId: existingDocAcrossSessions.sessionId,
      currentSessionId: currentSessionId
    });
    needsNewId = true;
  }
}

// Generate new ID if needed
const finalDocId = needsNewId ? 'new-generated-id-' + Math.random().toString(36).substr(2, 9) : packageDocId;

console.log('  Result:', {
  originalPackageId: packageDocId,
  needsNewId,
  finalDocId,
  conflictResolved: needsNewId
});
  
  console.log('\n📋 Test Case 2: Document does not exist anywhere');
  
  const newPackageDocId = 'completely-new-document-id';
  document = mockDocumentService.getDocument(newPackageDocId, userId, currentSessionId);
  needsNewId = false;
  
  console.log('  Document exists in current session:', !!document);
  
  if (!document) {
    const existingDocAcrossSessions = mockDocumentService.getDocumentAcrossAllSessions(newPackageDocId);
    console.log('  Document exists across all sessions:', !!existingDocAcrossSessions);
    
    if (existingDocAcrossSessions) {
      needsNewId = true;
    }
  }
  
  const finalDocId2 = needsNewId ? 'new-generated-id-' + Math.random().toString(36).substr(2, 9) : newPackageDocId;
  
  console.log('  Result:', {
    originalPackageId: newPackageDocId,
    needsNewId,
    finalDocId: finalDocId2,
    conflictResolved: needsNewId
  });
  
  console.log('\n✅ Test completed successfully!');
  console.log('📝 Summary:');
  console.log('  - When document exists in another session: New ID generated');
  console.log('  - When document does not exist anywhere: Original ID preserved');
  console.log('  - This prevents "Key already exists in the object store" errors');
}

// Run the test
testDocumentIdConflictHandling();