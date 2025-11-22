// Direct fix script - run this in your browser console
// This will directly update the model without affecting API key

(async function fixModel() {
  console.log('[DIRECT FIX] Starting direct model fix...');
  
  // Step 1: Open IndexedDB
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('RAGChatDB', 1);
    request.onerror = reject;
    request.onsuccess = () => resolve(request.result);
  });
  
  // Step 2: Get current settings
  const currentSettings = await new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');
    const request = store.get('app-settings');
    request.onerror = reject;
    request.onsuccess = () => resolve(request.result);
  });
  
  console.log('[DIRECT FIX] Current model:', currentSettings?.model);
  console.log('[DIRECT FIX] API Key exists:', !!currentSettings?.geminiApiKey);
  
  // Step 3: Update only the model
  const updatedSettings = {
    ...currentSettings,
    model: 'gemini-2.5-flash-lite'
  };
  
  // Step 4: Save updated settings
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readwrite');
    const store = transaction.objectStore('settings');
    const request = store.put(updatedSettings);
    request.onerror = reject;
    request.onsuccess = resolve;
  });
  
  // Step 5: Clear Zustand cache
  localStorage.removeItem('settings-store');
  
  console.log('[DIRECT FIX] Model updated to:', updatedSettings.model);
  console.log('[DIRECT FIX] API Key preserved:', !!updatedSettings.geminiApiKey);
  console.log('[DIRECT FIX] Clearing cache and reloading...');
  
  // Step 6: Reload page
  setTimeout(() => window.location.reload(), 500);
  
  db.close();
})();