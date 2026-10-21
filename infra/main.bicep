// Effort Tracker: web app, PostgreSQL, Blob Storage, Key Vault.
// Nothing here has been deployed. Pick the subscription and resource group first (see README).
// The Azure OpenAI key is NOT created here: it belongs to the existing shared OpenAI resource in another
// subscription, so it is stored as a Key Vault secret by hand after deployment.

targetScope = 'resourceGroup'

@description('Short lowercase name used as a prefix, e.g. "efor".')
param prefix string = 'efor'

@description('EU region. Data stays in Azure in the EU.')
param location string = resourceGroup().location

@description('App Service plan SKU. P0v3 is enough for ~14 users.')
param planSku string = 'P0v3'

@description('Region for PostgreSQL. Separate because a region can run out of database capacity (Sweden Central did on 2026-10-12).')
param pgLocation string = location

@secure()
@description('PostgreSQL administrator password.')
param pgAdminPassword string

@description('Allowed Entra tenants: "tenantId:Name:domain,tenantId:Name:domain".')
param allowedTenants string

@description('Entra app registration (client) id.')
param entraClientId string

@description('Azure OpenAI endpoint of the shared OpenAI resource.')
param openAiEndpoint string

@description('Azure OpenAI deployment name for GPT-6 Sol.')
param openAiDeployment string = 'gpt-6-sol'

@description('ITSM address, e.g. https://sd.beta.example.com. The API key is entered on the Yönetim page and saved to Key Vault.')
param itsmBaseUrl string = ''

@description('Tenant id whose people use the ticket system (Beta).')
param itsmTenantId string = ''

@description('Public URL of the app (custom domain or *.azurewebsites.net).')
param publicUrl string

var suffix = uniqueString(resourceGroup().id)
var kvName = 'kv-${prefix}-${take(suffix, 6)}'
var pgName = 'pg-${prefix}-${take(uniqueString(resourceGroup().id, pgLocation), 6)}'
var saName = take('st${prefix}${suffix}', 24)
var appName = 'app-${prefix}-${take(suffix, 6)}'

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    // Access policies, not RBAC: the deploying account may be Contributor without rights to assign roles.
    enableRbacAuthorization: false
    accessPolicies: []
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: saName
  location: location
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true
  }
}

resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource uploads 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'efor-uploads'
  properties: { publicAccess: 'None' }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgName
  location: pgLocation
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: 'eforadmin'
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'efor'
}

// Lets Azure services (the web app) connect. Tighten with VNet integration if the policy requires it.
resource pgAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource kvDbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'database-url'
  properties: { value: 'postgres://eforadmin:${uriComponent(pgAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/efor?sslmode=require' }
}

resource kvStorage 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'storage-connection-string'
  properties: { value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${prefix}-${take(suffix, 6)}'
  location: location
  kind: 'linux'
  sku: { name: planSku }
  properties: { reserved: true }
}

var kvRef = '@Microsoft.KeyVault(VaultName=${kv.name};SecretName='

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node dist/server/index.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/healthz'
      appSettings: concat([
        { name: 'NODE_ENV', value: 'production' }
        { name: 'AUTH_MODE', value: 'entra' }
        { name: 'PUBLIC_URL', value: publicUrl }
        { name: 'ALLOWED_TENANTS', value: allowedTenants }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        { name: 'ENTRA_CLIENT_SECRET', value: '${kvRef}entra-client-secret)' }
        { name: 'SESSION_SECRET', value: '${kvRef}session-secret)' }
        { name: 'DATABASE_URL', value: '${kvRef}database-url)' }
        { name: 'AZURE_STORAGE_CONNECTION_STRING', value: '${kvRef}storage-connection-string)' }
        { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
        { name: 'AZURE_OPENAI_KEY', value: '${kvRef}openai-key)' }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAiDeployment }
        // One instance runs the jobs (they also take a database lock), so these can stay on.
        { name: 'SYNC_ENABLED', value: 'true' }
        { name: 'SCHEDULER_ENABLED', value: 'true' }
        { name: 'SMTP_URL', value: '${kvRef}smtp-url)' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'KEY_VAULT_NAME', value: kv.name }
      ], empty(itsmBaseUrl) ? [] : [
        // The API key is NOT a setting: the Yönetim page writes it to Key Vault and the app reads it from there.
        { name: 'ITSM_BASE_URL', value: itsmBaseUrl }
        { name: 'ITSM_TENANT_ID', value: itsmTenantId }
      ])
    }
  }
}

// The web app's managed identity can read secrets (and nothing else).
resource kvPolicy 'Microsoft.KeyVault/vaults/accessPolicies@2023-07-01' = {
  parent: kv
  name: 'add'
  properties: {
    accessPolicies: [
      {
        tenantId: tenant().tenantId
        objectId: app.identity.principalId
        // 'set' lets the Yönetim page save the ITSM key; the app code only ever writes the secret named itsm-api-key.
        permissions: { secrets: ['get', 'list', 'set'] }
      }
    ]
  }
}

output webAppName string = app.name
output webAppHost string = app.properties.defaultHostName
output keyVaultName string = kv.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
output storageAccount string = storage.name
output managedIdentityPrincipalId string = app.identity.principalId
