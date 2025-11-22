// Test script to verify API key persistence
// Run this in your browser console after setting an API key

(async function testApiKeyPersistence() {
  console.log('🔍 Testing API Key Persistence...');
  
  try {
    // Step 1: Check IndexedDB directly
    console.log('\n=== CHECKING INDEXEDDB ===');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('RAGChatDB', 1);
      request.onerror = reject;
      request.onsuccess = () => resolve(request.result);
    });
    
    const settings = await new Promise((resolve, reject) => {
      const transaction = db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get('app-settings');
      request.onerror = reject;
      request.onsuccess = () => resolve(request.result);
    });
    
    console.log('IndexedDB Settings:', {
      geminiApiKey: settings?.geminiApiKey ? `Set (${settings.geminiApiKey.length} chars)` : 'Not set',
      model: settings?.model || 'undefined',
      id: settings?.id || 'undefined'
    });
    
    // Step 2: Check Zustand store
    console.log('\n=== CHECKING ZUSTAND STORE ===');
    const zustandData = localStorage.getItem('settings-store');
    if (zustandData) {
      const parsed = JSON.parse(zustandData);
      console.log('Zustand Store:', {
        geminiApiKey: parsed.state?.settings?.geminiApiKey ? `Set (${parsed.state?.settings?.geminiApiKey.length} chars)` : 'Not set',
        model: parsed.state?.settings?.model || 'undefined'
      });
    } else {
      console.log('Zustand Store: No data found');
    }
    
    // Step 3: Test API key format
    if (settings?.geminiApiKey) {
      console.log('\n=== VALIDATING API KEY ===');
      const geminiKeyPattern = /^AIza[0-9A-Za-z_-]{35}$/;
      const isValid = geminiKeyPattern.test(settings.geminiApiKey);
      console.log('API Key Format:', isValid ? '✅ Valid' : '❌ Invalid');
      console.log('API Key Length:', settings.geminiApiKey.length);
      console.log('API Key Prefix:', settings.geminiApiKey.substring(0, 7) + '...');
    }
    
    // Step 4: Check if API key is being used by Gemini service
    console.log('\n=== TESTING GEMINI SERVICE ===');
    try {
      const { geminiService } = await import('./src/services/gemini/index.js');
      const hasKey = await geminiService.hasApiKey();
      console.log('Gemini Service has API Key:', hasKey ? '✅ Yes' : '❌ No');
    } catch (error) {
      console.log('Gemini Service Test:', '❌ Error -', error.message);
    }
    
    console.log('\n🎯 DIAGNOSIS:');
    if (!settings?.geminiApiKey) {
      console.log('❌ API Key not saved to IndexedDB');
    } else if (!zustandData) {
      console.log('❌ API Key not persisted to Zustand store');
    } else {
      console.log('✅ API Key appears to be saved correctly');
      console.log('💡 Issue might be in the UI loading process');
    }
    
    db.close();
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
})();