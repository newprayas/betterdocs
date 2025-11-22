#!/usr/bin/env node

// Terminal fix script - run with: node terminal-fix.js
// This creates a browser automation script to update the model

const fs = require('fs');
const path = require('path');

console.log('🔧 Creating browser automation script for model update...');

// Create a temporary HTML file with the fix script
const fixScript = `
<!DOCTYPE html>
<html>
<head>
    <title>Model Fix</title>
</head>
<body>
    <h1>Running model fix...</h1>
    <script>
        (async function fixModel() {
            console.log('[TERMINAL FIX] Starting model fix...');
            
            try {
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
                
                console.log('[TERMINAL FIX] Current model:', currentSettings?.model);
                console.log('[TERMINAL FIX] API Key exists:', !!currentSettings?.geminiApiKey);
                
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
                
                console.log('[TERMINAL FIX] ✅ Model updated to:', updatedSettings.model);
                console.log('[TERMINAL FIX] ✅ API Key preserved:', !!updatedSettings.geminiApiKey);
                console.log('[TERMINAL FIX] ✅ Cache cleared');
                
                document.body.innerHTML = '<h1>✅ Model successfully updated to gemini-2.5-flash-lite</h1><p>You can close this window and test your app.</p>';
                
                db.close();
                
            } catch (error) {
                console.error('[TERMINAL FIX] ❌ Error:', error);
                document.body.innerHTML = '<h1>❌ Error updating model</h1><p>' + error.message + '</p>';
            }
        })();
    </script>
</body>
</html>
`;

// Write the HTML file
const htmlPath = path.join(__dirname, 'model-fix.html');
fs.writeFileSync(htmlPath, fixScript);

console.log('✅ Created model-fix.html');
console.log('');
console.log('📋 Instructions:');
console.log('1. Open model-fix.html in your browser (in the same domain as your app)');
console.log('2. The script will automatically update the model to gemini-2.5-flash-lite');
console.log('3. Your API key will be preserved');
console.log('4. After completion, test your app');
console.log('');
console.log('🌐 Open this file in your browser:');
console.log(`file://${htmlPath}`);
console.log('');
console.log('Or run this command to open it automatically (macOS):');
console.log(`open file://${htmlPath}`);