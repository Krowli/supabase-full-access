import { useFlag } from 'common'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { useIsJitDbAccessEnabled } from '@/components/interfaces/App/FeaturePreview/FeaturePreviewContext'
import { DiskManagementPanelForm } from '@/components/interfaces/DiskManagement/DiskManagementPanelForm'
import { BannedIPs } from '@/components/interfaces/Settings/Database/BannedIPs'
import { ConnectionLogging } from '@/components/interfaces/Settings/Database/ConnectionLogging'
import { ConnectionPooling } from '@/components/interfaces/Settings/Database/ConnectionPooling/ConnectionPooling'
import { DatabaseReadOnlyAlert } from '@/components/interfaces/Settings/Database/DatabaseReadOnlyAlert'
import { ResetDbPassword } from '@/components/interfaces/Settings/Database/DatabaseSettings/ResetDbPassword'
import { DiskSizeConfiguration } from '@/components/interfaces/Settings/Database/DiskSizeConfiguration'
import { JitDbAccessConfiguration } from '@/components/interfaces/Settings/Database/JitDatabaseAccess/JitDbAccessConfiguration'
import { NetworkRestrictions } from '@/components/interfaces/Settings/Database/NetworkRestrictions/NetworkRestrictions'
import { PoolingModesModal } from '@/components/interfaces/Settings/Database/PoolingModesModal'
import { SettingsDatabaseEmptyStateLocal } from '@/components/interfaces/Settings/Database/SettingsDatabaseEmptyStateLocal'
import { SSLConfiguration } from '@/components/interfaces/Settings/Database/SSLConfiguration'
import { DatabaseLayout } from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { useIsAwsCloudProvider, useIsAwsK8sCloudProvider } from '@/hooks/misc/useSelectedProject'
import { IS_PLATFORM } from '@/lib/constants'
import type { NextPageWithLayout } from '@/types'

const DatabaseSettings: NextPageWithLayout = () => {
  const isAws = useIsAwsCloudProvider()
  const isAwsK8s = useIsAwsK8sCloudProvider()
  const jitDbAccessEnabled = useIsJitDbAccessEnabled()
  const showNewDiskManagementUI = isAws || isAwsK8s
  const { databaseNetworkRestrictions } = useIsFeatureEnabled(['database:network_restrictions'])
  const databaseLogsConfigurationEnabled = useFlag('databaseLogsConfiguration')

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>Database Settings</PageHeaderTitle>
            <PageHeaderDescription>
              Connections, security, and network configuration
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      {IS_PLATFORM ? (
        <>
          <PageContainer size="small" className="flex flex-col gap-8 pb-12">
            <DatabaseReadOnlyAlert />
            <ResetDbPassword />
            {jitDbAccessEnabled && <JitDbAccessConfiguration />}
            <ConnectionPooling />
            <SSLConfiguration />
            {showNewDiskManagementUI ? (
              // This form is hidden if Disk and Compute form is enabled, new form is on ./settings/infrastructure
              <DiskManagementPanelForm />
            ) : (
              <DiskSizeConfiguration />
            )}
            {databaseNetworkRestrictions && <NetworkRestrictions />}
            {databaseLogsConfigurationEnabled && <ConnectionLogging />}
            <BannedIPs />
          </PageContainer>
          <PoolingModesModal />
        </>
      ) : (
        // Self-hosted, connection pooling is the one section on this page that is settable: the
        // fork serves `/config/pgbouncer` and `/config/supavisor` from the Supavisor admin API.
        // Everything else here still lives in the compose file, which is what the card explains.
        <>
          <PageContainer size="small" className="flex flex-col gap-8 pb-12">
            <ConnectionPooling />
            <PageSection>
              <PageSectionContent className="space-y-4 md:space-y-8">
                <SettingsDatabaseEmptyStateLocal />
              </PageSectionContent>
            </PageSection>
          </PageContainer>
          <PoolingModesModal />
        </>
      )}
    </>
  )
}

DatabaseSettings.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title="Settings">{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseSettings
