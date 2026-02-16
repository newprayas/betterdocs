export interface LibraryItem {
  id: string;
  name: string;
  filename: string;
  size: string;
  category: string;
  url: string; // Constructed dynamically in the service
}
