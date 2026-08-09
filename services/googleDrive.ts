
const DEFAULT_CLIENT_ID = '56948120254-m59lif4kp30j901rqj7gl5i94edgtt26.apps.googleusercontent.com'; 
const REDIRECT_URI = window.location.origin + '/';
const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';

export interface GDriveBackupFile {
  name: string;
  id: string;
  createdTime: string;
  displayDate: string;
}

export interface GDriveFolder {
  id: string;
  name: string;
  isGlobalResult?: boolean;
}

export class GoogleDriveService {
  private token: string | null = null;

  constructor(token?: string) {
    this.token = token || localStorage.getItem('gdrive_token');
  }

  // --- PKCE Helpers for Permanent Handshake ---
  private static generateRandomString(length: number): string {
    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(array).map(x => charset[x % charset.length]).join('');
  }

  private static async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  static async getAuthUrl() {
    const clientId = localStorage.getItem('custom_gdrive_client_id') || DEFAULT_CLIENT_ID;
    const verifier = this.generateRandomString(64);
    localStorage.setItem('gdrive_code_verifier', verifier); 
    
    const challenge = await this.generateCodeChallenge(verifier);
    
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline', 
      prompt: 'consent', 
      state: 'gdrive'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  static async exchangeCodeForTokens(code: string): Promise<{ access_token: string, refresh_token?: string, expires_in: number }> {
    const clientId = localStorage.getItem('custom_gdrive_client_id') || DEFAULT_CLIENT_ID;
    const clientSecret = localStorage.getItem('custom_gdrive_client_secret');
    const verifier = localStorage.getItem('gdrive_code_verifier');

    if (!verifier) {
      throw new Error('Code verifier missing. Please clear browser storage and try linking again.');
    }

    const params: Record<string, string> = {
      client_id: clientId,
      code: code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    };

    if (clientSecret) {
      params.client_secret = clientSecret;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('Exchange failed:', result);
      throw new Error(result.error_description || result.error || 'Failed to exchange code');
    }

    localStorage.removeItem('gdrive_code_verifier');
    return result;
  }

  static async refreshAccessToken(refreshToken: string): Promise<{ access_token: string, expires_in: number, refresh_token?: string }> {
    const clientId = localStorage.getItem('custom_gdrive_client_id') || DEFAULT_CLIENT_ID;
    const clientSecret = localStorage.getItem('custom_gdrive_client_secret');

    const params: Record<string, string> = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };

    if (clientSecret) {
      params.client_secret = clientSecret;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('Refresh failed:', result);
      throw new Error('Permanent Link lost - refresh token may be revoked');
    }

    return result;
  }

  private async fetchG(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.token}`);
    let response = await fetch(url, { ...options, headers });
    
    if (response.status === 401) {
      const refreshToken = localStorage.getItem('gdrive_refresh_token');
      if (refreshToken) {
        try {
          console.log("[GDriveService] Access token expired. Attempting refresh...");
          const res = await GoogleDriveService.refreshAccessToken(refreshToken);
          this.token = res.access_token;
          localStorage.setItem('gdrive_token', res.access_token);
          localStorage.setItem('gdrive_token_expiry', (new Date().getTime() + res.expires_in * 1000).toString());
          if (res.refresh_token) {
            localStorage.setItem('gdrive_refresh_token', res.refresh_token);
          }
          
          // Retry the request with the new token
          headers.set('Authorization', `Bearer ${this.token}`);
          response = await fetch(url, { ...options, headers });
          
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Drive Error after refresh');
          }
          return response.json();
        } catch (refreshErr) {
          console.error("[GDriveService] Auto-refresh failed:", refreshErr);
          throw new Error('TOKEN_EXPIRED');
        }
      }
      throw new Error('TOKEN_EXPIRED');
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Drive Error');
    }
    return response.json();
  }

  async listFolders(parentId: string = 'root'): Promise<GDriveFolder[]> {
    if (!this.token) return [];
    const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const data = await this.fetchG(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name`);
    return data.files || [];
  }

  /**
   * Searches for folders globally by name. This helps find folders in 'Other computers' 
   * or shared locations that aren't under the current breadcrumb path.
   */
  async searchFolders(nameQuery: string): Promise<GDriveFolder[]> {
    if (!this.token || !nameQuery.trim()) return [];
    const q = `name contains '${nameQuery.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const data = await this.fetchG(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name&pageSize=20`);
    return (data.files || []).map((f: any) => ({ ...f, isGlobalResult: true }));
  }

  /**
   * Finds or creates a folder. 
   * If parentId is null, it performs a global search across the drive first 
   * to avoid duplicates and respect existing folder structures.
   */
  private async getOrCreateFolder(name: string, parentId?: string): Promise<string> {
    // 1. Construct query
    // If no parent specified, search entire drive (don't limit to root) to find existing folders
    const q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentId ? ` and '${parentId}' in parents` : ""}`;
    
    const data = await this.fetchG(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
    
    // 2. If found, return the first matching ID
    if (data.files && data.files.length > 0) return data.files[0].id;

    // 3. If not found, create it
    const metadata: any = { 
      name, 
      mimeType: 'application/vnd.google-apps.folder' 
    };
    
    // Only set parents if explicitly provided, otherwise Drive defaults to Root
    if (parentId) {
      metadata.parents = [parentId];
    }
    
    const created = await this.fetchG('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
    return created.id;
  }

  private async getBackupRootId(): Promise<string> {
    const folderId = localStorage.getItem('gdrive_backup_folder_id');
    if (folderId) return folderId;
    
    const folderName = localStorage.getItem('gdrive_backup_folder_name') || 'backups';
    return await this.getOrCreateFolder(folderName);
  }

  async uploadData(data: any) {
    if (!this.token) throw new Error("GDocs not connected");
    const content = JSON.stringify(data, null, 2);
    
    const backupFolderId = await this.getBackupRootId();
    const fileName = this.generateTimestampedFilename();
    
    const metadata = { name: fileName, mimeType: 'application/json', parents: [backupFolderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));

    let response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form
    });

    if (response.status === 401) {
      const refreshToken = localStorage.getItem('gdrive_refresh_token');
      if (refreshToken) {
        const res = await GoogleDriveService.refreshAccessToken(refreshToken);
        this.token = res.access_token;
        localStorage.setItem('gdrive_token', res.access_token);
        localStorage.setItem('gdrive_token_expiry', (new Date().getTime() + res.expires_in * 1000).toString());
        
        // Retry
        response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: form
        });
      }
    }

    if (!response.ok) throw new Error("Upload failed");
    return fileName;
  }

  private generateTimestampedFilename() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `backup-${yyyy}${mm}${dd}-${hh}${min}.json`;
  }

  async listBackups(): Promise<GDriveBackupFile[]> {
    if (!this.token) throw new Error("Drive not linked");
    const folderId = await this.getBackupRootId();
    const q = `'${folderId}' in parents and trashed = false and mimeType = 'application/json'`;
    const data = await this.fetchG(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&orderBy=name desc`);
    
    return (data.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime,
      displayDate: new Date(f.createdTime).toLocaleString()
    }));
  }

  async downloadData(fileId: string) {
    if (!this.token) throw new Error("Drive not linked");
    let response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (response.status === 401) {
      const refreshToken = localStorage.getItem('gdrive_refresh_token');
      if (refreshToken) {
        const res = await GoogleDriveService.refreshAccessToken(refreshToken);
        this.token = res.access_token;
        localStorage.setItem('gdrive_token', res.access_token);
        localStorage.setItem('gdrive_token_expiry', (new Date().getTime() + res.expires_in * 1000).toString());
        
        response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
      }
    }

    if (!response.ok) throw new Error("Download failed");
    return response.json();
  }

  async checkTallyInbox() {
    if (!this.token) return [];
    try {
      const inboxId = localStorage.getItem('gdrive_tally_inbox_id');
      let targetFolderId = inboxId;
      
      if (!targetFolderId) {
        const inboxFolderName = localStorage.getItem('gdrive_tally_inbox_name') || 'tally_inbox';
        targetFolderId = await this.getOrCreateFolder(inboxFolderName);
      }

      const q = `'${targetFolderId}' in parents and trashed = false`;
      const listData = await this.fetchG(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
      const results = [];
      const validFiles = (listData.files || []).filter((f: any) => 
        f.name.toLowerCase().endsWith('.xlsx') || f.name.toLowerCase().endsWith('.xls') || f.name.toLowerCase().endsWith('.xml')
      );
      for (const file of validFiles) {
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        const buffer = await response.arrayBuffer();
        results.push({ name: file.name, buffer, path: file.id });
      }
      return results;
    } catch (e) { 
      console.error("GDrive Inbox Check Error:", e);
      return []; 
    }
  }

  async archiveProcessedFile(fileId: string) {
    if (!this.token) return;
    try {
      const processedIdStore = localStorage.getItem('gdrive_tally_processed_id');
      let targetFolderId = processedIdStore;

      if (!targetFolderId) {
        const processedFolderName = localStorage.getItem('gdrive_tally_processed_name') || 'processed_tally';
        targetFolderId = await this.getOrCreateFolder(processedFolderName);
      }

      const fileMetadata = await this.fetchG(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`);
      const previousParents = (fileMetadata.parents || []).join(',');
      await this.fetchG(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}${previousParents ? `&removeParents=${previousParents}` : ''}`, { 
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch (e) {
      console.error("Archive failed:", e);
    }
  }
}
