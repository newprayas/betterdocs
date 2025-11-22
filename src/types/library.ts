export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  filename: string;
  size: string;
  category: string;
  version: string;
  url: string; // Constructed dynamically in the service
}