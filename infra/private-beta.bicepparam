using './main.bicep'

param location = readEnvironmentVariable('AZURE_LOCATION')
param functionAppName = readEnvironmentVariable('AZURE_FUNCTIONAPP_NAME')
param hostStorageAccountName = readEnvironmentVariable('AZURE_HOST_STORAGE_ACCOUNT_NAME')
param mediaStorageAccountName = readEnvironmentVariable('AZURE_MEDIA_STORAGE_ACCOUNT_NAME')
param googleClientIds = readEnvironmentVariable('GOOGLE_CLIENT_IDS')
param allowedGoogleEmails = readEnvironmentVariable('ALLOWED_GOOGLE_EMAILS', '')
param mediaContainerName = readEnvironmentVariable('AZURE_STORAGE_CONTAINER', 'media')
param quotaTableName = readEnvironmentVariable('AZURE_QUOTA_TABLE', 'syncachuquota')
param storageQuotaBytes = readEnvironmentVariable('STORAGE_QUOTA_BYTES', '1000000000000')
