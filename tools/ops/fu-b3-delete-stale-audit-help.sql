DELETE FROM help_content WHERE tenant_id IS NULL AND key IN ('admin.audit','admin.audit.archives','admin.audit.export.format') AND version = 1;
