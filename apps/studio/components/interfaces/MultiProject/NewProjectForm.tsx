import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Button, Form, FormControl, FormField, Input } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import { FormSchema } from '@/components/interfaces/ProjectCreation/ProjectCreation.schema'
import Panel from '@/components/ui/Panel'
import { useProjectCreateMutation } from '@/data/projects/project-create-mutation'

/**
 * Fork: "New project" on a multi-project self-hosted Studio (deploy/platform/SPEC.md M6), in place
 * of upstream's form, which needs the platform's regions, plans and feature flags. The control
 * plane picks the ref and generates every secret, the database password included, so a name is
 * all there is to ask. Every project belongs to the one self-hosted organization.
 */

const ORGANIZATION_SLUG = 'default-org-slug'

// Upstream's rules for a project name, so both forms accept the same names.
const NewProjectSchema = z.object({ projectName: FormSchema.innerType().shape.projectName })

type NewProjectValues = z.infer<typeof NewProjectSchema>

export const NewProjectForm = () => {
  const router = useRouter()
  const [error, setError] = useState<string>()

  const form = useForm<NewProjectValues>({
    resolver: zodResolver(NewProjectSchema),
    defaultValues: { projectName: '' },
  })

  const {
    mutate: createProject,
    isPending,
    isSuccess,
  } = useProjectCreateMutation({
    onSuccess: (res) => router.push(`/project/${res.ref}`),
    onError: (err) => setError(err.message),
  })

  const onSubmit = ({ projectName }: NewProjectValues) => {
    setError(undefined)
    // `dbPass` is required by the shared mutation's type; Studio's route never forwards it.
    createProject({ name: projectName, organizationSlug: ORGANIZATION_SLUG, dbPass: '' })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Panel
          title={
            <div key="panel-title">
              <h3>Create a new project</h3>
              <p className="text-sm text-foreground-lighter text-balance">
                Your project gets its own Postgres database, Auth, Data API and Storage.
                Provisioning takes a few minutes.
              </p>
            </div>
          }
          footer={
            <div key="panel-footer" className="flex w-full items-center justify-end gap-2">
              <Button
                type="button"
                variant="default"
                disabled={isPending}
                onClick={() => router.back()}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={isPending || isSuccess}>
                Create new project
              </Button>
            </div>
          }
        >
          <Panel.Content className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="projectName"
              render={({ field }) => (
                <FormItemLayout label="Project name" layout="horizontal">
                  <FormControl>
                    <Input {...field} placeholder="Project name" />
                  </FormControl>
                </FormItemLayout>
              )}
            />
            <p className="text-sm text-foreground-light">
              The database password is generated for you and kept, encrypted, by the control plane.
            </p>
            {error && (
              <Admonition type="destructive" title="Failed to create new project">
                {error}
              </Admonition>
            )}
          </Panel.Content>
        </Panel>
      </form>
    </Form>
  )
}
