/**
 * GHL Workflow Builder Tools
 * 
 * 7 tools for full workflow CRUD via the hidden internal GHL API.
 * These go beyond the public API (which only lists workflows) to provide:
 * - Create workflows with triggers and actions
 * - Get/list workflows with full action data (workflowData.templates)
 * - Update workflow actions and triggers
 * - Delete, publish, and clone workflows
 * 
 * Auth: Firebase token refresh (browser-free, no CDP needed).
 * See SKILL.md at skills/ghl-workflow-builder/SKILL.md for full schemas.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  WorkflowBuilderClient,
  WorkflowAction,
  WorkflowTrigger,
} from '../clients/workflow-builder-client.js';

import { kcPlanRequests, KcPartialWriteError, kcLaneMode, kcTargetLocation } from '../kc/lane.js';

/** Tool result for a multi-step write that created something and then failed: name it, never hide it. */
/** Remove the KC-added locationId argument (used outside KC lanes to keep upstream schemas). */
function kcStripLocationArg(tool: Tool): Tool {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  if (!schema?.properties || !('locationId' in schema.properties)) return tool;
  const { locationId: _drop, ...properties } = schema.properties;
  const req = (tool.inputSchema as { required?: string[] }).required;
  const inputSchema = { ...tool.inputSchema, properties } as Tool['inputSchema'] & { required?: string[] };
  if (Array.isArray(req)) inputSchema.required = req.filter((r) => r !== 'locationId');
  return { ...tool, inputSchema };
}

function kcPartialResult(err: KcPartialWriteError, c: WorkflowBuilderClient): ToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: false,
        partial: true,
        createdWorkflowId: err.createdId,
        completed: err.completed,
        failed: err.failedStep,
        error: err.message,
        url: `https://app.gohighlevel.com/v2/location/${c.getLocationId()}/automation/workflow/${err.createdId}`,
        nextStep: `Do not create it again. Finish it with ghl_update_workflow_actions on workflowId ${err.createdId}, or delete it with ghl_delete_workflow_internal.`,
      }, null, 2),
    }],
    isError: true,
  };
}

// ─── Tool result type ───────────────────────────────────────

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────

function success(data: unknown): ToolResult {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function error(msg: string): ToolResult {
  return {
    content: [{ type: 'text', text: msg }],
    isError: true,
  };
}

// ─── Tool class ─────────────────────────────────────────────

export class WorkflowBuilderTools {
  private client: WorkflowBuilderClient | null = null;
  private initError: string | null = null;

  constructor() {
    try {
      this.client = WorkflowBuilderClient.fromEnv();
    } catch (err: any) {
      this.initError = err.message;
      process.stderr.write(`[WorkflowBuilderTools] Init warning: ${err.message}\n`);
    }
  }

  /**
   * Returns MCP tool definitions for the 7 workflow builder tools.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [
      // ─── CREATE ─────────────────────────────────────────
      {
        name: 'ghl_create_workflow',
        description:
          'Create a new GHL workflow with optional trigger and actions. ' +
          'Actions are chained automatically via next/parentKey unless you provide explicit linkage (for branching). ' +
          'Returns the created workflow with ID, status, and action details. ' +
          'Trigger types: contact_tag, contact_created, form_submission, customer_reply, appointment, inbound_webhook, payment_received, etc. ' +
          'Action types: sms, email, add_contact_tag, wait, if_else, webhook, create_opportunity, custom_code, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            name: {
              type: 'string',
              description: 'Workflow name (required)',
            },
            trigger: {
              type: 'object',
              description: 'Optional trigger. Properties: type (string, required), name (string), data (object with trigger-specific config like tagName, tagEvent)',
              properties: {
                type: { type: 'string', description: 'Trigger type: contact_tag, form_submission, contact_created, customer_reply, appointment, inbound_webhook, payment_received, etc.' },
                name: { type: 'string', description: 'Display name for the trigger' },
                data: { type: 'object', description: 'Trigger-specific data, e.g. {tagName: "hot-lead", tagEvent: "added"} for contact_tag' },
              },
              required: ['type'],
            },
            actions: {
              type: 'array',
              description: 'Array of action objects. Each has: type (string, required), name (string, required), attributes (object). Steps are linked automatically with a single next id. For branching only, set id, next (array of branch IDs), parentKey, cat, nodeType.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'Action type: sms, email, add_contact_tag, wait, if_else, webhook, etc.' },
                  name: { type: 'string', description: 'Display name' },
                  attributes: { type: 'object', description: 'Action config (body, tags, delay, conditions, etc.)' },
                  id: { type: 'string', description: 'Optional UUID — auto-generated if omitted' },
                  next: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Next action id (string) for linear steps; array of branch ids only on if/else or multi-path steps. Auto-chained if omitted.' },
                  parentKey: { type: 'string', description: 'Previous action ID — auto-set if omitted' },
                  cat: { type: 'string', description: 'Category (conditions, multi-path, transition)' },
                  nodeType: { type: 'string', description: 'Node type (condition-node, branch-yes, branch-no)' },
                },
                required: ['type', 'name'],
              },
            },
            publish: {
              type: 'boolean',
              description: 'If true, publish the workflow immediately after creation (default: draft)',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'write', complexity: 'complex' } },
      } as Tool,

      // ─── LIST FULL ──────────────────────────────────────
      {
        name: 'ghl_list_workflows_full',
        description:
          'List all workflows with names, IDs, and statuses via the internal API. ' +
          'Returns more data than the public API including workflow counts and status breakdown. ' +
          'Supports pagination via limit/offset.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            limit: { type: 'number', description: 'Max workflows to return (default 50)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
            sortBy: { type: 'string', description: 'Sort field: name, createdAt, updatedAt (default name)' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default asc)' },
          },
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'read', complexity: 'simple' } },
      } as Tool,

      // ─── GET FULL ───────────────────────────────────────
      {
        name: 'ghl_get_workflow_full',
        description:
          'Get a single workflow with full detail: all action nodes (workflowData.templates), ' +
          'triggers, version, status, and metadata. Use this to inspect workflow structure before updating.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            workflowId: {
              type: 'string',
              description: 'The workflow ID to retrieve',
            },
          },
          required: ['workflowId'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'read', complexity: 'simple' } },
      } as Tool,

      // ─── UPDATE ACTIONS ─────────────────────────────────
      {
        name: 'ghl_update_workflow_actions',
        description:
          'Add or replace actions (and optionally triggers) in an existing workflow. ' +
          'Automatically handles version tracking (GETs current version before PUT). ' +
          'Actions are auto-chained unless explicit next/parentKey is provided for branching. ' +
          'Can also update workflow name and status.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            workflowId: {
              type: 'string',
              description: 'The workflow ID to update',
            },
            name: {
              type: 'string',
              description: 'New workflow name (optional)',
            },
            actions: {
              type: 'array',
              description: 'New actions array — replaces all existing actions',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  name: { type: 'string' },
                  attributes: { type: 'object' },
                  id: { type: 'string' },
                  next: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                  parentKey: { type: 'string' },
                  cat: { type: 'string' },
                  nodeType: { type: 'string' },
                },
                required: ['type', 'name'],
              },
            },
            triggers: {
              type: 'array',
              description: 'New triggers — replaces existing triggers',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  name: { type: 'string' },
                  data: { type: 'object' },
                },
                required: ['type'],
              },
            },
            status: {
              type: 'string',
              enum: ['draft', 'published'],
              description: 'Set workflow status',
            },
          },
          required: ['workflowId'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'write', complexity: 'complex' } },
      } as Tool,

      // ─── DELETE ─────────────────────────────────────────
      {
        name: 'ghl_delete_workflow_internal',
        description:
          'Permanently delete a workflow by ID through the internal workflow-builder API. This cannot be undone. ' +
          'Returns confirmation of deletion.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            workflowId: {
              type: 'string',
              description: 'The workflow ID to delete',
            },
          },
          required: ['workflowId'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'delete', complexity: 'simple' } },
      } as Tool,

      // ─── PUBLISH ────────────────────────────────────────
      {
        name: 'ghl_publish_workflow',
        description:
          'Publish a draft workflow, making it active and able to be triggered. ' +
          'Equivalent to flipping status from "draft" to "published". ' +
          'Returns the updated workflow state.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            workflowId: {
              type: 'string',
              description: 'The workflow ID to publish',
            },
          },
          required: ['workflowId'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'write', complexity: 'simple' } },
      } as Tool,

      // ─── CLONE ──────────────────────────────────────────
      {
        name: 'ghl_clone_workflow',
        description:
          'Duplicate an existing workflow with a new name. Clones all actions and triggers ' +
          'with remapped IDs. The clone starts as a draft. ' +
          'Returns the new workflow with its ID and full action data.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: {
              type: 'string',
              description: 'Sub-account (location) ID. Optional: defaults to this connection\'s account. Pinned connections accept only their own account; the agency connection accepts any sub-account.',
            },
            workflowId: {
              type: 'string',
              description: 'The source workflow ID to clone',
            },
            newName: {
              type: 'string',
              description: 'Name for the cloned workflow (default: "{original name} (copy)")',
            },
          },
          required: ['workflowId'],
          additionalProperties: false,
        },
        _meta: { labels: { category: 'workflows', access: 'write', complexity: 'complex' } },
      } as Tool,
    ];
    // KC lanes add an optional per-call sub-account; outside a lane the upstream schemas are unchanged.
    // A KC lane without a GHL login (no Firebase secrets, e.g. a read-only lane) exposes no workflow-builder tools.
    if (kcLaneMode() && !this.client) return [];
    return kcLaneMode() ? tools : tools.map(kcStripLocationArg);
  }

  /**
   * Execute a workflow builder tool by name.
   */
  async executeWorkflowBuilderTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client && kcLaneMode()) {
      return error('KC lane: this lane has no GHL login; workflow-builder tools are unavailable here.');
    }
    if (!this.client) {
      return error(
        `Workflow builder not initialized: ${this.initError || 'Unknown error'}. ` +
        'Ensure GHL_FIREBASE_API_KEY and GHL_FIREBASE_REFRESH_TOKEN are set.'
      );
    }

    try {
      const loc = kcLaneMode() ? (params.locationId ?? kcTargetLocation()) : undefined;
      const c = loc === undefined || loc === '' ? this.client : this.client.forLocation(loc as string);
      switch (name) {
        case 'ghl_create_workflow':
          return await this.createWorkflow(params, c);
        case 'ghl_list_workflows_full':
          return await this.listWorkflowsFull(params, c);
        case 'ghl_get_workflow_full':
          return await this.getWorkflowFull(params, c);
        case 'ghl_update_workflow_actions':
          return await this.updateWorkflowActions(params, c);
        case 'ghl_delete_workflow_internal':
          return await this.deleteWorkflow(params, c);
        case 'ghl_publish_workflow':
          return await this.publishWorkflow(params, c);
        case 'ghl_clone_workflow':
          return await this.cloneWorkflow(params, c);
        default:
          return error(`Unknown workflow builder tool: ${name}`);
      }
    } catch (err: any) {
      return error(`Error executing ${name}: ${err.message}`);
    }
  }

  // ─── Tool Implementations ─────────────────────────────────

  private async createWorkflow(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return error('name is required');

    const rawActions = params.actions as WorkflowAction[] | undefined;
    const trigger = params.trigger as WorkflowTrigger | undefined;
    const publish = params.publish as boolean | undefined;
    const needsUpdate = !!(rawActions?.length || trigger || publish);
    // KC lanes: log in first (that can take time), then refuse to start unless every write still fits.
    if (kcLaneMode()) await c.kcPrepareAuth();
    kcPlanRequests('create workflow', needsUpdate ? 3 : 1);

    // Step 1: Create empty workflow
    const { id } = await c.createWorkflow(name);
    try {
      return await this.finishCreateWorkflow(c, id, name, rawActions, trigger, publish);
    } catch (err) {
      if (!kcLaneMode()) throw err;
      return kcPartialResult(new KcPartialWriteError(id, `creating the empty workflow "${name}"`, 'a later step (adding actions, trigger, publish, or reading it back)', err), c);
    }
  }

  private async finishCreateWorkflow(
    c: WorkflowBuilderClient, id: string, name: string,
    rawActions: WorkflowAction[] | undefined, trigger: WorkflowTrigger | undefined, publish: boolean | undefined,
  ): Promise<ToolResult> {
    // Step 2: Add actions if provided

    if (rawActions?.length || trigger) {
      await c.updateWorkflow(id, {
        actions: rawActions,
        triggers: trigger ? [trigger] : undefined,
        status: publish ? 'published' : 'draft',
      });
    }

    // Step 3: Publish if requested (and not already done above)
    if (publish && !rawActions?.length && !trigger) {
      await c.publishWorkflow(id);
    }

    // Return final state
    const workflow = await c.getWorkflow(id);
    return success({
      message: `Workflow "${name}" created successfully`,
      workflow: {
        id: workflow._id,
        name: workflow.name,
        status: workflow.status,
        version: workflow.version,
        actionCount: workflow.workflowData?.templates?.length || 0,
        actions: (workflow.workflowData?.templates || []).map((t, i) => ({
          order: i,
          type: t.type,
          name: t.name,
          id: t.id,
        })),
        url: `https://app.gohighlevel.com/v2/location/${c.getLocationId()}/automation/workflow/${workflow._id}`,
      },
    });
  }

  private async listWorkflowsFull(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const result = await c.listWorkflows({
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined,
      sortBy: params.sortBy as string | undefined,
      sortOrder: params.sortOrder as 'asc' | 'desc' | undefined,
    });

    return success({
      total: result.total,
      count: result.rows.length,
      workflows: result.rows.map(w => ({
        id: w._id,
        name: w.name,
        status: w.status,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
    });
  }

  private async getWorkflowFull(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const workflowId = params.workflowId as string;
    if (!workflowId) return error('workflowId is required');

    const workflow = await c.getWorkflow(workflowId);

    return success({
      id: workflow._id,
      name: workflow.name,
      status: workflow.status,
      version: workflow.version,
      actionCount: workflow.workflowData?.templates?.length || 0,
      actions: workflow.workflowData?.templates || [],
      triggers: workflow.triggers || [],
      url: `https://app.gohighlevel.com/v2/location/${c.getLocationId()}/automation/workflow/${workflow._id}`,
    });
  }

  private async updateWorkflowActions(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const workflowId = params.workflowId as string;
    if (!workflowId) return error('workflowId is required');

    const workflow = await c.updateWorkflow(workflowId, {
      name: params.name as string | undefined,
      actions: params.actions as WorkflowAction[] | undefined,
      triggers: params.triggers as WorkflowTrigger[] | undefined,
      status: params.status as 'draft' | 'published' | undefined,
    });

    return success({
      message: `Workflow "${workflow.name}" updated successfully`,
      id: workflow._id,
      name: workflow.name,
      status: workflow.status,
      version: workflow.version,
      actionCount: workflow.workflowData?.templates?.length || 0,
      actions: (workflow.workflowData?.templates || []).map((t, i) => ({
        order: i,
        type: t.type,
        name: t.name,
        id: t.id,
      })),
    });
  }

  private async deleteWorkflow(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const workflowId = params.workflowId as string;
    if (!workflowId) return error('workflowId is required');

    await c.deleteWorkflow(workflowId);

    return success({
      message: `Workflow ${workflowId} deleted successfully`,
      workflowId,
    });
  }

  private async publishWorkflow(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const workflowId = params.workflowId as string;
    if (!workflowId) return error('workflowId is required');

    const workflow = await c.publishWorkflow(workflowId);

    return success({
      message: `Workflow "${workflow.name}" published successfully`,
      id: workflow._id,
      name: workflow.name,
      status: workflow.status,
      version: workflow.version,
    });
  }

  private async cloneWorkflow(params: Record<string, unknown>, c: WorkflowBuilderClient): Promise<ToolResult> {
    const workflowId = params.workflowId as string;
    if (!workflowId) return error('workflowId is required');

    const newName = params.newName as string | undefined;
    let workflow;
    try {
      workflow = await c.cloneWorkflow(workflowId, newName);
    } catch (err) {
      if (err instanceof KcPartialWriteError) return kcPartialResult(err, c);
      throw err;
    }

    return success({
      message: `Workflow cloned as "${workflow.name}"`,
      sourceId: workflowId,
      newWorkflow: {
        id: workflow._id,
        name: workflow.name,
        status: workflow.status,
        version: workflow.version,
        actionCount: workflow.workflowData?.templates?.length || 0,
        url: `https://app.gohighlevel.com/v2/location/${c.getLocationId()}/automation/workflow/${workflow._id}`,
      },
    });
  }
}

// ─── Helper for tool registry ───────────────────────────────

export function isWorkflowBuilderTool(toolName: string): boolean {
  return [
    'ghl_create_workflow',
    'ghl_list_workflows_full',
    'ghl_get_workflow_full',
    'ghl_update_workflow_actions',
    'ghl_delete_workflow_internal',
    'ghl_publish_workflow',
    'ghl_clone_workflow',
  ].includes(toolName);
}
