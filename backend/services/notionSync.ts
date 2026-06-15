/**
 * Notion task sync service — uses the Notion REST API directly (no SDK dependency).
 *
 * Expects a Notion integration with access to the tasks database.
 * Database must have these properties:
 *   - Title (title)         → task.title
 *   - Status (select)       → "Not Started" | "In Progress" | "Completed"
 *   - Due Date (date)       → task.dueDate
 *   - Description (rich_text)
 *   - SF ID (rich_text)     → task.sfID  (optional, for cross-system link)
 *   - Owner (rich_text)     → task.ownerName
 */

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function headers() {
    return {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    };
}

export interface NotionTask {
    notionPageId: string;
    title: string;
    description?: string;
    status: "Not Started" | "In Progress" | "Completed";
    dueDate?: Date;
    sfID?: string;
    ownerName?: string;
    lastEdited: Date;
}

function extractRichText(prop: any): string {
    return prop?.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
}

function extractTitle(prop: any): string {
    return prop?.title?.map((t: any) => t.plain_text).join("") ?? "";
}

function mapStatus(value: string | undefined): NotionTask["status"] {
    if (value === "In Progress") return "In Progress";
    if (value === "Completed") return "Completed";
    return "Not Started";
}

function pageToNotionTask(page: any): NotionTask {
    const props = page.properties ?? {};
    return {
        notionPageId: page.id,
        title: extractTitle(props.Title ?? props.Name ?? props.title ?? {}),
        description: extractRichText(props.Description ?? props.description ?? {}),
        status: mapStatus(props.Status?.select?.name ?? props.status?.select?.name),
        dueDate: props["Due Date"]?.date?.start
            ? new Date(props["Due Date"].date.start)
            : props.dueDate?.date?.start
            ? new Date(props.dueDate.date.start)
            : undefined,
        sfID: extractRichText(props["SF ID"] ?? props.sfID ?? {}),
        ownerName: extractRichText(props.Owner ?? props.owner ?? {}),
        lastEdited: new Date(page.last_edited_time),
    };
}

/** Pull all task pages from the configured Notion database. */
export async function pullNotionTasks(since?: Date): Promise<NotionTask[]> {
    const dbId = process.env.NOTION_TASKS_DATABASE_ID;
    if (!process.env.NOTION_API_KEY || !dbId) {
        console.warn("[notionSync] NOTION_API_KEY or NOTION_TASKS_DATABASE_ID not set — skipping pull");
        return [];
    }

    const tasks: NotionTask[] = [];
    let cursor: string | undefined;

    do {
        const body: any = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        if (since) {
            body.filter = {
                timestamp: "last_edited_time",
                last_edited_time: { after: since.toISOString() },
            };
        }

        let res: Response;
        try {
            res = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body),
            });
        } catch (err: any) {
            console.error("[notionSync] Network error querying Notion:", err.message);
            break;
        }

        if (!res.ok) {
            const text = await res.text();
            console.error(`[notionSync] Notion query failed ${res.status}:`, text);
            break;
        }

        const data = await res.json() as { results: any[]; next_cursor?: string; has_more: boolean };
        for (const page of data.results) {
            tasks.push(pageToNotionTask(page));
        }
        cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    return tasks;
}

/** Create a new Notion page for a task. Returns the new page id or null. */
export async function createNotionTask(task: {
    title: string;
    description?: string;
    status?: string;
    dueDate?: Date | string;
    sfID?: string;
    ownerName?: string;
}): Promise<string | null> {
    const dbId = process.env.NOTION_TASKS_DATABASE_ID;
    if (!process.env.NOTION_API_KEY || !dbId) {
        console.warn("[notionSync] NOTION_API_KEY or NOTION_TASKS_DATABASE_ID not set — skipping create");
        return null;
    }

    const properties: any = {
        Title: { title: [{ text: { content: task.title } }] },
        Status: { select: { name: task.status ?? "Not Started" } },
    };
    if (task.description) {
        properties.Description = { rich_text: [{ text: { content: task.description.slice(0, 2000) } }] };
    }
    if (task.dueDate) {
        const iso = task.dueDate instanceof Date
            ? task.dueDate.toISOString().split("T")[0]
            : String(task.dueDate).split("T")[0];
        properties["Due Date"] = { date: { start: iso } };
    }
    if (task.sfID) {
        properties["SF ID"] = { rich_text: [{ text: { content: task.sfID } }] };
    }
    if (task.ownerName) {
        properties.Owner = { rich_text: [{ text: { content: task.ownerName } }] };
    }

    let res: Response;
    try {
        res = await fetch(`${NOTION_BASE}/pages`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ parent: { database_id: dbId }, properties }),
        });
    } catch (err: any) {
        console.error("[notionSync] Network error creating Notion page:", err.message);
        return null;
    }

    if (!res.ok) {
        const text = await res.text();
        console.error(`[notionSync] Create page failed ${res.status}:`, text);
        return null;
    }

    const page = await res.json() as { id: string };
    return page.id;
}

/** Update an existing Notion page. Returns true on success. */
export async function updateNotionTask(pageId: string, task: {
    title?: string;
    description?: string;
    status?: string;
    dueDate?: Date | string | null;
    sfID?: string;
    ownerName?: string;
}): Promise<boolean> {
    if (!process.env.NOTION_API_KEY) {
        console.warn("[notionSync] NOTION_API_KEY not set — skipping update");
        return false;
    }

    const properties: any = {};
    if (task.title !== undefined) {
        properties.Title = { title: [{ text: { content: task.title } }] };
    }
    if (task.status !== undefined) {
        properties.Status = { select: { name: task.status } };
    }
    if (task.description !== undefined) {
        properties.Description = { rich_text: [{ text: { content: (task.description ?? "").slice(0, 2000) } }] };
    }
    if (task.dueDate !== undefined) {
        if (task.dueDate === null) {
            properties["Due Date"] = { date: null };
        } else {
            const iso = task.dueDate instanceof Date
                ? task.dueDate.toISOString().split("T")[0]
                : String(task.dueDate).split("T")[0];
            properties["Due Date"] = { date: { start: iso } };
        }
    }
    if (task.sfID !== undefined) {
        properties["SF ID"] = { rich_text: [{ text: { content: task.sfID } }] };
    }
    if (task.ownerName !== undefined) {
        properties.Owner = { rich_text: [{ text: { content: task.ownerName } }] };
    }

    let res: Response;
    try {
        res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
            method: "PATCH",
            headers: headers(),
            body: JSON.stringify({ properties }),
        });
    } catch (err: any) {
        console.error("[notionSync] Network error updating Notion page:", err.message);
        return false;
    }

    if (!res.ok) {
        const text = await res.text();
        console.error(`[notionSync] Update page ${pageId} failed ${res.status}:`, text);
        return false;
    }

    return true;
}

/** Push a task to Notion — creates if no notionPageId, updates otherwise. Returns page id. */
export async function pushTaskToNotion(task: {
    _id?: any;
    notionPageId?: string;
    title: string;
    description?: string;
    status?: string;
    dueDate?: Date | string | null;
    sfID?: string;
    ownerName?: string;
}): Promise<string | null> {
    if (task.notionPageId) {
        const ok = await updateNotionTask(task.notionPageId, task);
        return ok ? task.notionPageId : null;
    }
    return createNotionTask(task as any);
}
