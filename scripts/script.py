import subprocess
import os

cluster = 'artistic-hippopotamus-hw7oq2'
service = 'personal-web-app-task-definition-service-4t236x8c'

task_def_cmd = f'aws ecs describe-services --cluster {cluster} --services {service} --query "services[0].taskDefinition" --output text'
activeTaskDef = subprocess.check_output(task_def_cmd, shell=True).decode().strip()

all_tasks_cmd = f'aws ecs list-tasks --cluster {cluster} --service-name {service} --desired-status RUNNING --query "taskArns" --output text'
allTaskArns = subprocess.check_output(all_tasks_cmd, shell=True).decode().strip().replace('\t', ' ').replace('\n', ' ')

task_id_cmd = f'aws ecs describe-tasks --cluster {cluster} --tasks {allTaskArns} --query "tasks[?taskDefinitionArn==`{activeTaskDef}`].taskArn | [0]" --output text'
taskIdResult = subprocess.check_output(task_id_cmd, shell=True).decode().strip()
taskId = taskIdResult.split('/')[-1]

print('TaskId:', taskId)

email = 'geoffrey.murray.1995@gmail.com'
pwd_hash = '$2b$10$BwP5Hzjz/CcZpy6x6rrtAOXBqY8IkwytTBhtHnJWbiUNSmjrfZTQq'

eval_script = f"""
var email = '{email}';
var lead = db.leads.findOne({{email: email}});
if(lead) {{
    db.users.insertOne({{
        name: (lead.firstName||'')+' '+(lead.lastName||''),
        email: email,
        password: '{pwd_hash}',
        role: 'admin',
        isVerified: true
    }});
    db.leads.deleteOne({{_id: lead._id}});
    print('Converted lead directly to user with admin role and reset pass');
}} else {{
    var user = db.users.findOne({{email: email}});
    if (user) {{
        db.users.updateOne({{_id: user._id}}, {{$set: {{role: 'admin', password: '{pwd_hash}'}}}});
        print('Updated user ' + email + ' role to admin and reset pass');
    }} else {{
        print('Could not find ' + email + ' in leads or users');
    }}
}}
"""

args = [
    'aws', 'ecs', 'execute-command',
    '--cluster', cluster,
    '--task', taskId,
    '--container', 'mongodb',
    '--interactive',
    '--command', f'mongosh personal_web_app --eval "{eval_script}"'
]

print('Running AWS SSM...')
result = subprocess.run(args, capture_output=True, text=True)
print('STDOUT:')
print(result.stdout)
print('STDERR:')
print(result.stderr)
