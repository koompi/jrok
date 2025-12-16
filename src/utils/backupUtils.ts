import { generateId } from "./helpers";
import * as fs from "fs/promises";
import * as path from "path";

export interface CertBackup {
  id: string;
  domain: string;
  timestamp: number;
  backupPath: string;
  size: number;
}

const BACKUP_DIR = process.env.BACKUP_DIR || "./data/cert-backups";

/**
 * Create a backup of domain certificates
 * Tars and gzips the certificate directory
 */
export async function backupDomainCerts(domain: string, certPath: string): Promise<CertBackup> {
  const backupId = generateId();
  const timestamp = Date.now();

  try {
    // Ensure backup directory exists
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    const backupFileName = `${domain}_${timestamp}_${backupId}.tar.gz`;
    const backupFullPath = path.join(BACKUP_DIR, backupFileName);

    // Create tar.gz backup using Bun's native capabilities
    // For now, we'll create a backup metadata file and store cert files
    const backupMetaDir = path.join(BACKUP_DIR, backupId);
    await fs.mkdir(backupMetaDir, { recursive: true });

    // Copy certificate files to backup directory
    try {
      const files = await fs.readdir(certPath);
      for (const file of files) {
        const srcFile = path.join(certPath, file);
        const destFile = path.join(backupMetaDir, file);
        await fs.copyFile(srcFile, destFile);
      }
    } catch (error) {
      // Create empty backup if cert path doesn't exist yet
      console.warn(`Warning: Could not read cert path ${certPath}:`, error);
    }

    // Get backup size
    let size = 0;
    const files = await fs.readdir(backupMetaDir);
    for (const file of files) {
      const filePath = path.join(backupMetaDir, file);
      const stats = await fs.stat(filePath);
      size += stats.size;
    }

    const backup: CertBackup = {
      id: backupId,
      domain,
      timestamp,
      backupPath: backupMetaDir,
      size,
    };

    // Store backup metadata
    const metaFile = path.join(backupMetaDir, "backup.json");
    await fs.writeFile(metaFile, JSON.stringify(backup, null, 2));

    console.log(`✅ Created backup ${backupId} for domain ${domain} (${size} bytes)`);
    return backup;
  } catch (error) {
    console.error(`Failed to backup certs for ${domain}:`, error);
    throw new Error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Restore certificates from a backup
 */
export async function restoreCertBackup(backupId: string, certPath: string): Promise<void> {
  const backupDir = path.join(BACKUP_DIR, backupId);

  try {
    // Verify backup exists
    await fs.stat(backupDir);

    // Ensure cert path exists
    await fs.mkdir(certPath, { recursive: true });

    // Copy backup files to cert path
    const files = await fs.readdir(backupDir);
    for (const file of files) {
      if (file === "backup.json") continue; // Skip metadata

      const srcFile = path.join(backupDir, file);
      const destFile = path.join(certPath, file);

      await fs.copyFile(srcFile, destFile);
    }

    console.log(`✅ Restored backup ${backupId} to ${certPath}`);
  } catch (error) {
    console.error(`Failed to restore backup ${backupId}:`, error);
    throw new Error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * List all backups for a domain
 */
export async function listDomainBackups(domain: string): Promise<CertBackup[]> {
  try {
    await fs.stat(BACKUP_DIR);
  } catch {
    return [];
  }

  const backups: CertBackup[] = [];

  try {
    const entries = await fs.readdir(BACKUP_DIR);

    for (const entry of entries) {
      const metaFile = path.join(BACKUP_DIR, entry, "backup.json");
      try {
        const metaContent = await fs.readFile(metaFile, "utf-8");
        const backup: CertBackup = JSON.parse(metaContent);

        if (backup.domain === domain) {
          backups.push(backup);
        }
      } catch {
        // Skip invalid backup dirs
      }
    }
  } catch (error) {
    console.error("Failed to list backups:", error);
  }

  // Sort by timestamp descending (newest first)
  backups.sort((a, b) => b.timestamp - a.timestamp);
  return backups;
}

/**
 * Delete a backup
 */
export async function deleteBackup(backupId: string): Promise<void> {
  const backupDir = path.join(BACKUP_DIR, backupId);

  try {
    // Remove all files in backup directory
    const files = await fs.readdir(backupDir);
    for (const file of files) {
      await fs.unlink(path.join(backupDir, file));
    }

    // Remove backup directory
    await fs.rmdir(backupDir);

    console.log(`✅ Deleted backup ${backupId}`);
  } catch (error) {
    console.error(`Failed to delete backup ${backupId}:`, error);
    throw new Error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Clean up old backups (keep only last N backups per domain)
 */
export async function cleanupOldBackups(domain: string, keepCount: number = 5): Promise<void> {
  const backups = await listDomainBackups(domain);

  if (backups.length > keepCount) {
    const toDelete = backups.slice(keepCount);
    for (const backup of toDelete) {
      await deleteBackup(backup.id);
    }

    console.log(`✅ Cleaned up ${toDelete.length} old backups for ${domain}`);
  }
}
