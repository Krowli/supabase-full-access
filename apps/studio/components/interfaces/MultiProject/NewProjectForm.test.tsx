import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { NewProjectForm } from './NewProjectForm'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

/**
 * Fork: the multi-project Studio's "New project" form (deploy/platform/SPEC.md M6). A name is all
 * it asks for; the control plane generates the database password.
 */

const REF = 'newprojectnewproject'

let created: Record<string, unknown>[]

beforeEach(() => {
  created = []
  routerMock.setCurrentUrl('/new-project')
  mswServer.use(
    http.post(`${API_URL}/platform/projects`, async ({ request }) => {
      created.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({ ref: REF, name: 'My shop', status: 'COMING_UP' }, { status: 201 })
    })
  )
})

describe('NewProjectForm', () => {
  it('asks for a name only and says where the database password comes from', () => {
    customRender(<NewProjectForm />)

    expect(screen.getByLabelText('Project name')).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.getByText(/database password is generated/i)).toBeInTheDocument()
  })

  it('refuses an empty name without creating anything', async () => {
    customRender(<NewProjectForm />)

    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))

    expect(await screen.findByText('Please enter a project name.')).toBeInTheDocument()
    expect(created).toEqual([])
  })

  it('refuses a name shorter than three characters', async () => {
    customRender(<NewProjectForm />)

    await userEvent.type(screen.getByLabelText('Project name'), 'ab')
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))

    expect(
      await screen.findByText('Project name must be at least 3 characters long.')
    ).toBeInTheDocument()
    expect(created).toEqual([])
  })

  it('creates the project and opens it', async () => {
    customRender(<NewProjectForm />)

    await userEvent.type(screen.getByLabelText('Project name'), '  My shop ')
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))

    await waitFor(() => expect(routerMock.asPath).toBe(`/project/${REF}`))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ name: 'My shop', organization_slug: 'default-org-slug' })
  })

  it('shows why the control plane refused, and stays on the form', async () => {
    mswServer.use(
      http.post(`${API_URL}/platform/projects`, () =>
        HttpResponse.json({ message: 'control plane POST /projects answered 500' }, { status: 502 })
      )
    )
    customRender(<NewProjectForm />)

    await userEvent.type(screen.getByLabelText('Project name'), 'My shop')
    fireEvent.click(screen.getByRole('button', { name: 'Create new project' }))

    expect(
      await screen.findByText('control plane POST /projects answered 500', { exact: false })
    ).toBeInTheDocument()
    expect(routerMock.asPath).toBe('/new-project')
  })
})
