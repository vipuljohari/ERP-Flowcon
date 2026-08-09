
import { Dropbox } from 'dropbox';

const CLIENT_ID = '2z3yte6cnk3iyn5'; 
const REDIRECT_URI = window.location.origin + '/';
const BACKUP_FOLDER = '/backups';
const INBOX_FOLDER = '/tally_inbox';
const PROCESSED_FOLDER = '/processed_tally';

export interface DropboxBackupFile {
  name: string;
  path: string;
  client_modified: string;
  displayDate: string;
}

export class DropboxService {
  private dbx: Dropbox | null = null;

  constructor(accessToken?: string) {
    if (accessToken) {
      this.dbx = new Dropbox({ accessToken });
    }
  }

  static getAuthUrl() {
    const scopes = ['files.content.read', 'files.content.write', 'files.metadata.read'].join(' ');
    const url = `https://www.dropbox.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=token&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    return url;
  }

  private generateTimestampedFilename() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}${mm}${dd}-${hh}${min}.json`;
  }

  async uploadData(data: any) {
    if (!this.dbx) throw new Error("Dropbox not connected");
    const fileName = this.generateTimestampedFilename();
    const path = `${BACKUP_FOLDER}/${fileName}`;
    const fileContent = JSON.stringify(data, null, 2);
    const blob = new Blob([fileContent], { type: 'application/json' });
    try {
      await this.dbx.filesUpload({ path, contents: blob, mode: { '.tag': 'overwrite' } as any });
      await this.dbx.filesUpload({ path: '/latest_master.json', contents: blob, mode: { '.tag': 'overwrite' } as any });
      return fileName;
    } catch (error: any) { throw error; }
  }

  /**
   * Scans the /tally_inbox folder for new files to process automatically
   */
  async checkTallyInbox() {
    if (!this.dbx) return [];
    try {
      // Create folders if they don't exist
      try { await this.dbx.filesCreateFolderV2({ path: INBOX_FOLDER }); } catch(e) {}
      try { await this.dbx.filesCreateFolderV2({ path: PROCESSED_FOLDER }); } catch(e) {}

      const response = await this.dbx.filesListFolder({ path: INBOX_FOLDER });
      const files = response.result.entries.filter(e => e['.tag'] === 'file' && (e.name.endsWith('.xlsx') || e.name.endsWith('.xls') || e.name.endsWith('.xml')));
      
      const results = [];
      for (const file of files) {
        const download = await this.dbx.filesDownload({ path: (file as any).path_lower });
        const res: any = download.result;
        const buffer = await res.fileBlob.arrayBuffer();
        
        results.push({
          name: file.name,
          buffer,
          path: (file as any).path_lower
        });
      }
      return results;
    } catch (error) {
      console.error("Inbox check failed:", error);
      return [];
    }
  }

  /**
   * Moves a processed file to the archive folder to prevent double-import
   */
  async archiveProcessedFile(path: string) {
    if (!this.dbx) return;
    const fileName = path.split('/').pop();
    const newPath = `${PROCESSED_FOLDER}/${new Date().getTime()}_${fileName}`;
    try {
      await this.dbx.filesMoveV2({ from_path: path, to_path: newPath });
    } catch (error) {
      console.error("Archive failed:", error);
    }
  }

  async listBackups(): Promise<DropboxBackupFile[]> {
    if (!this.dbx) throw new Error("Dropbox not connected");
    try {
      const listResponse = await this.dbx.filesListFolder({ path: BACKUP_FOLDER });
      const entries = listResponse.result.entries.filter(e => e['.tag'] === 'file') as any[];
      return entries.map(e => {
        const nameParts = e.name.split('.')[0].split('-');
        let displayDate = e.name;
        if (nameParts.length === 2) {
            const datePart = nameParts[0];
            const timePart = nameParts[1];
            displayDate = `${datePart.substring(6,8)} ${new Date(0, parseInt(datePart.substring(4,6))-1).toLocaleString('default', { month: 'short' })} ${datePart.substring(0,4)} at ${timePart.substring(0,2)}:${timePart.substring(2,4)}`;
        }
        return { name: e.name, path: e.path_lower, client_modified: e.client_modified, displayDate };
      }).sort((a, b) => b.name.localeCompare(a.name));
    } catch (error) { return []; }
  }

  async downloadData(specificPath?: string) {
    if (!this.dbx) throw new Error("Dropbox not connected");
    try {
      let targetPath = specificPath || '/latest_master.json';
      const response = await this.dbx.filesDownload({ path: targetPath });
      const result: any = response.result;
      const text = await result.fileBlob.text();
      return JSON.parse(text);
    } catch (error: any) { return null; }
  }
}
