# Meddy - Chat with Documents Privately (Web Version)

A web-based RAG (Retrieval-Augmented Generation) chat application that allows you to privately chat with your documents using Google's Gemini AI.

## Features

- 🚀 **Private & Local**: All documents processed and stored locally in your browser
- 💬 **Real-time Chat**: Streaming responses with source citations
- 📄 **Document Management**: Import pre-processed document packages
- 🎨 **Dark Theme**: Beautiful dark interface matching Flutter app
- 📱 **Mobile-First**: Responsive design that works on all devices
- 🔍 **Vector Search**: Fast semantic search through your documents
- ⚡ **Performance**: Optimized for large document collections

## Quick Start

### Prerequisites

- Node.js 18+ 
- Modern web browser with IndexedDB support

### Installation

1. **Clone and install dependencies**:
   ```bash
   cd rag-web
   npm install
   ```

2. **Set up environment**:
   ```bash
   cp .env.local.example .env.local
   # Edit .env.local with your Gemini API key
   ```

3. **Run development server**:
   ```bash
   npm run dev
   ```

4. **Open your browser** and navigate to `http://localhost:3000`

### Getting Gemini API Key

1. Visit [Google AI Studio](https://ai.google.dev)
2. Sign in with your Google account
3. Create a new API key
4. Copy the key and add it to your `.env.local` file

## Usage

### 1. Create a Session
- Click "New Session" on the home page
- Give your session a name and optional description
- Add a custom system prompt if desired

### 2. Import Documents
- Navigate to your session
- Go to the "Documents" tab
- Click "Import Packages" and select pre-processed JSON files
- Wait for processing to complete

### 3. Start Chatting
- Switch to the "Chat" tab
- Ask questions about your documents
- Get real-time responses with source citations

## Document Format

The app accepts pre-processed JSON packages with the following structure:

```json
{
  "format_version": "1.0",
  "export_metadata": { ... },
  "document_metadata": { ... },
  "chunks": [
    {
      "id": "chunk_id",
      "text": "chunk content",
      "embedding": [0.1, 0.2, ...],
      "metadata": { ... }
    }
  ],
  "export_stats": { ... }
}
```

## Architecture

### Technology Stack
- **Frontend**: Next.js 14 + React 18 + TypeScript
- **Styling**: Tailwind CSS with custom dark theme
- **State**: Zustand with persistence
- **Storage**: IndexedDB with Dexie wrapper
- **AI**: Google Gemini API for embeddings and chat
- **Search**: Custom vector similarity search

### Key Features
- **Vector Search**: Fast semantic search through document embeddings
- **Streaming Chat**: Real-time response generation
- **Citations**: Automatic source attribution with page numbers
- **Offline-First**: Works without internet after initial setup
- **PWA Ready**: Installable as a desktop/mobile app

## Development

### Project Structure

```
src/
├── app/              # Next.js pages
├── components/        # React components
├── hooks/            # Custom React hooks
├── services/         # Business logic
├── store/            # Zustand state management
├── types/            # TypeScript definitions
├── utils/            # Utility functions
└── styles/           # CSS and styling
```

### Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run type-check   # Type checking only
npm run format       # Format code with Prettier
npm run medex-helper # Local MedEx helper for desktop development only
```

## MedEx Production Setup

### Production behavior

- Production web and mobile web now use the server route:
  - `/api/medex/query`
- Local desktop development can still use:
  - `npm run medex-helper`
- Common MedEx drug results can be shared across users with Vercel KV cache

### Environment variables

- Add these to Vercel if you want persistent shared MedEx cache:
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
- Fallback Upstash variable names are also supported:
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`

### Cache behavior

- The app stores the final parsed MedEx payload
- Cache is intended to stay indefinitely
- Raw MedEx HTML is not stored
- If KV is not configured, the route still works, but responses are uncached

## Browser Support

- Chrome 88+
- Firefox 90+
- Safari 14+
- Edge 88+

## Privacy & Security

- ✅ All data stored locally in IndexedDB
- ✅ No data sent to external servers (except Gemini API)
- ✅ API key encrypted in local storage
- ✅ No analytics or tracking
- ✅ Open source and auditable

## Performance

- 🚀 Optimized vector operations with Float32Array
- 📊 Efficient pagination for large document sets
- ⚡ WebAssembly support for heavy computations
- 🗄️ Smart caching and indexing strategies

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues, questions, or feature requests, please open an issue on the GitHub repository.
