export const MB = 1024 * 1024;
export const MAX_WAL_MB = 8;

export const POSTGRES_SETTINGS = [
  "shared_buffers = 16MB",
  "work_mem = 2MB",
  "maintenance_work_mem = 8MB",
  "temp_buffers = 2MB",
  "wal_buffers = 1MB",
  "min_wal_size = 2MB",
  `max_wal_size = ${MAX_WAL_MB}MB`,
  "log_min_error_statement = panic",
];
