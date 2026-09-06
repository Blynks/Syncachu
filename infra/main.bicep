targetScope = 'resourceGroup'

@description('Azure public-cloud region supporting both Flex Consumption Node.js 22 and Standard_ZRS storage.')
param location string = resourceGroup().location

@description('Globally unique Function App name. Use a dedicated app and plan for this deployment.')
@minLength(2)
@maxLength(58)
param functionAppName string

@description('Globally unique host/deployment StorageV2 account name: 3-24 lowercase letters or digits. Must differ from mediaStorageAccountName.')
@minLength(3)
@maxLength(24)
param hostStorageAccountName string

@description('Globally unique private media StorageV2 account name: 3-24 lowercase letters or digits. Also holds the global quota table.')
@minLength(3)
@maxLength(24)
param mediaStorageAccountName string

@description('Comma-separated explicit Google Web, Android, and iOS OAuth client IDs; no wildcards.')
@minLength(1)
param googleClientIds string

@secure()
@description('Comma-separated verified Google emails allowed into the beta. Empty denies everyone. Never commit real invitation lists.')
param allowedGoogleEmails string = ''

@description('Private media container. Changing this also changes the staging-only lifecycle prefix.')
@minLength(3)
@maxLength(63)
param mediaContainerName string = 'media'

@description('Azure Table name for the single global quota ledger in the media account. Must be 3-63 alphanumeric characters starting with a letter.')
@minLength(3)
@maxLength(63)
param quotaTableName string = 'syncachuquota'

@description('Positive decimal integer string in bytes. 1000000000000 is 1 TB total across all users and scale-out instances, not a billing cap.')
@minLength(1)
param storageQuotaBytes string = '1000000000000'

@description('Flex scale-out ceiling. 40 is the platform minimum, not a reserved or always-running instance count.')
@minValue(40)
@maxValue(1000)
param maximumInstanceCount int = 40

@description('Memory per on-demand instance. 2048 MB leaves headroom for large-file finalization.')
@allowed([512, 2048, 4096])
param instanceMemoryMB int = 2048

@description('Number of days deleted media blobs and containers remain recoverable and billable.')
@minValue(1)
@maxValue(365)
param mediaSoftDeleteRetentionDays int = 7

@description('Log Analytics retention, including workspace-based Application Insights data.')
@minValue(30)
@maxValue(90)
param logRetentionDays int = 30

@description('Best-effort daily Log Analytics ingestion limit in GB, not a hard spend cap. Logs stop after the cap is reached.')
@minValue(1)
@maxValue(10)
param logDailyQuotaGb int = 1

param tags object = {
  application: 'syncachu'
  environment: 'private-beta'
}

var deploymentContainerName = 'function-releases'
var roles = {
  blobOwner: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
  blobContributor: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  tableContributor: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  metricsPublisher: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${functionAppName}-runtime'
  location: location
  tags: tags
}

resource packageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${functionAppName}-packages'
  location: location
  tags: tags
}

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: hostStorageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'None'
    }
  }
}

resource hostBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
  properties: {}
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobs
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource mediaStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: mediaStorageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_ZRS'
  }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'None'
    }
  }
}

resource mediaBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: mediaStorage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: {
      enabled: true
      days: mediaSoftDeleteRetentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: mediaSoftDeleteRetentionDays
    }
  }
}

resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: mediaBlobs
  name: mediaContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource mediaTables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: mediaStorage
  name: 'default'
  properties: {}
}

resource quotaTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: mediaTables
  name: quotaTableName
  properties: {}
}

resource mediaLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: mediaStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-staging-after-upload-window'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${mediaContainerName}/staging/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 2
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: 2
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 2
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${functionAppName}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
    workspaceCapping: {
      dailyQuotaGb: logDailyQuotaGb
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-insights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: true
  }
}

resource hostBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, runtimeIdentity.id, roles.blobOwner)
  scope: hostStorage
  properties: {
    roleDefinitionId: roles.blobOwner
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource hostDiagnosticsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, runtimeIdentity.id, roles.tableContributor)
  scope: hostStorage
  properties: {
    roleDefinitionId: roles.tableContributor
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deploymentBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(deploymentContainer.id, packageIdentity.id, roles.blobContributor)
  scope: deploymentContainer
  properties: {
    roleDefinitionId: roles.blobContributor
    principalId: packageIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// User-delegation keys require storage-account scope, not only the media container.
resource mediaBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(mediaStorage.id, runtimeIdentity.id, roles.blobContributor)
  scope: mediaStorage
  properties: {
    roleDefinitionId: roles.blobContributor
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource mediaQuotaRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(quotaTable.id, runtimeIdentity.id, roles.tableContributor)
  scope: quotaTable
  properties: {
    roleDefinitionId: roles.tableContributor
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource telemetryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, runtimeIdentity.id, roles.metricsPublisher)
  scope: insights
  properties: {
    roleDefinitionId: roles.metricsPublisher
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource flexPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${functionAppName}-plan'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
      '${packageIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: flexPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: hostStorage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: runtimeIdentity.properties.clientId }
        { name: 'AZURE_CLIENT_ID', value: runtimeIdentity.properties.clientId }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'ClientId=${runtimeIdentity.properties.clientId};Authorization=AAD' }
        { name: 'GOOGLE_CLIENT_IDS', value: googleClientIds }
        { name: 'ALLOWED_GOOGLE_EMAILS', value: allowedGoogleEmails }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: mediaStorage.properties.primaryEndpoints.blob }
        { name: 'AZURE_STORAGE_CONTAINER', value: mediaContainer.name }
        { name: 'AZURE_QUOTA_TABLE', value: quotaTable.name }
        { name: 'STORAGE_QUOTA_BYTES', value: storageQuotaBytes }
      ]
    }
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '22'
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${hostStorage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: packageIdentity.id
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: instanceMemoryMB
        alwaysReady: []
        triggers: {
          http: {
            perInstanceConcurrency: 4
          }
        }
      }
    }
  }
  dependsOn: [
    hostBlobRole
    hostDiagnosticsRole
    deploymentBlobRole
    mediaBlobRole
    mediaQuotaRole
    telemetryRole
  ]
}

resource scmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource ftpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

output deployedFunctionAppName string = functionApp.name
output functionAppResourceId string = functionApp.id
output apiUrl string = 'https://${functionApp.properties.defaultHostName}/api'
output mediaStorageAccountUrl string = mediaStorage.properties.primaryEndpoints.blob
output mediaStorageAccountResourceId string = mediaStorage.id
output deployedMediaContainerName string = mediaContainer.name
output quotaTableResourceId string = quotaTable.id
output deployedQuotaTableName string = quotaTable.name
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
