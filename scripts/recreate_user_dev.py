import subprocess
import os

# Dev Environment Config
cluster = 'dev-cluster'
service = 'personal-web-app-dev-service'

def get_task_id():
    try:
        # Get the active task definition
        task_def_cmd = f'aws ecs describe-services --cluster {cluster} --services {service} --query "services[0].taskDefinition" --output text'
        activeTaskDef = subprocess.check_output(task_def_cmd, shell=True).decode().strip()
        
        # List running tasks for the service
        all_tasks_cmd = f'aws ecs list-tasks --cluster {cluster} --service-name {service} --desired-status RUNNING --query "taskArns" --output text'
        allTaskArns = subprocess.check_output(all_tasks_cmd, shell=True).decode().strip().replace('\t', ' ').replace('\n', ' ')
        
        if not allTaskArns or allTaskArns == 'None':
            print("No running tasks found for the dev service.")
            return None

        # Describe tasks to find the one with the active task definition
        task_id_cmd = f'aws ecs describe-tasks --cluster {cluster} --tasks {allTaskArns} --query "tasks[?taskDefinitionArn==`{activeTaskDef}`].taskArn | [0]" --output text'
        taskIdResult = subprocess.check_output(task_id_cmd, shell=True).decode().strip()
        
        if not taskIdResult or taskIdResult == 'None':
            print("Could not find a task matching the active task definition.")
            return None
            
        return taskIdResult.split('/')[-1]
    except Exception as e:
        print(f"Error fetching task ID: {e}")
        return None

taskId = get_task_id()

if taskId:
    print(f'Connecting to Dev TaskId: {taskId}')
    
    email = 'geoffrey.murray.1995@gmail.com'
    # This is the hash for 'password123' used in other scripts
    pwd_hash = '$2b$10$BwP5Hzjz/CcZpy6x6rrtAOXBqY8IkwytTBhtHnJWbiUNSmjrfZTQq'
    
    recreate_script = f"""
    var email = '{email}';
    var lead = db.leads.findOne({{email: email}});
    if (lead) {{
        db.users.insertOne({{
            name: (lead.firstName||'') + ' ' + (lead.lastName||''),
            email: email,
            password: '{pwd_hash}',
            role: 'admin',
            isVerified: true
        }});
        db.leads.deleteOne({{_id: lead._id}});
        print('Converted lead directly to user with admin role in DEV');
    }} else {{
        var user = db.users.findOne({{email: email}});
        if (user) {{
            db.users.updateOne(
                {{_id: user._id}}, 
                {{$set: {{role: 'admin', password: '{pwd_hash}'}}}}
            );
            print('Updated existing user ' + email + ' to admin in DEV');
        }} else {{
            // Create user from scratch if neither lead nor user exists
            db.users.insertOne({{
                name: 'Geoffrey Murray',
                email: email,
                password: '{pwd_hash}',
                role: 'admin',
                isVerified: true
            }});
            print('Created user ' + email + ' from scratch in DEV');
        }}
    }}
    """
    
    args = [
        'aws', 'ecs', 'execute-command',
        '--cluster', cluster,
        '--task', taskId,
        '--container', 'mongodb',
        '--interactive',
        '--command', f'mongosh personal_web_app --eval "{recreate_script}"'
    ]
    
    print('Running AWS SSM on Dev MongoDB container...')
    result = subprocess.run(args, capture_output=True, text=True)
    print('STDOUT:')
    print(result.stdout)
    print('STDERR:')
    print(result.stderr)
else:
    print("Failed to identify a running dev task.")
