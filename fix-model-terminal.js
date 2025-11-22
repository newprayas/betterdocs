// Terminal script to update model in IndexedDB
// Run with: node fix-model-terminal.js

const { open } = require('node:indexeddb');
const path = require('path');

async function updateModel() {
  try {
    console.log('[MODEL UPDATE] Starting model update...');
    
    // Open the IndexedDB database
    const dbPath = path.join(process.cwd(), '.indexeddb');
    const db = await open('RAGChatDB', 1);
    
    // Get current settings
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');
    const request = store.get('app-settings');
    
    const currentSettings = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    console.log('[MODEL UPDATE] Current settings:', currentSettings);
    
    // Update only the model, preserve everything else
    const updatedSettings = {
      ...currentSettings,
      model: 'gemini-2.5-flash-lite'
    };
    
    // Save updated settings
    const updateTransaction = db.transaction(['settings'], 'readwrite');
    const updateStore = updateTransaction.objectStore('settings');
    const updateRequest = updateStore.put(updatedSettings);
    
    await new Promise((resolve, reject) => {
      updateRequest.onsuccess = () => resolve();
      updateRequest.onerror = () => reject(updateRequest.error);
    });
    
    console.log('[MODEL UPDATE] Model updated to:', updatedSettings.model);
    console.log('[MODEL UPDATE] Success! Please restart your dev server.');
    
    db.close();
    
  } catch (error) {
    console.error('[MODEL UPDATE ERROR]', error);
    console.log('[MODEL UPDATE] Please try the browser console method instead.');
  }
}

updateModel();