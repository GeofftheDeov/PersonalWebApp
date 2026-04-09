import subprocess
import os

cluster = 'artistic-hippopotamus-hw7oq2'
service = 'personal-web-app-task-definition-service-4t236x8c'

def get_task_id():
    task_def_cmd = f'aws ecs describe-services --cluster {cluster} --services {service} --query "services[0].taskDefinition" --output text'
    activeTaskDef = subprocess.check_output(task_def_cmd, shell=True).decode().strip()
    all_tasks_cmd = f'aws ecs list-tasks --cluster {cluster} --service-name {service} --desired-status RUNNING --query "taskArns" --output text'
    allTaskArns = subprocess.check_output(all_tasks_cmd, shell=True).decode().strip().replace('\t', ' ').replace('\n', ' ')
    task_id_cmd = f'aws ecs describe-tasks --cluster {cluster} --tasks {allTaskArns} --query "tasks[?taskDefinitionArn==`{activeTaskDef}`].taskArn | [0]" --output text'
    taskIdResult = subprocess.check_output(task_id_cmd, shell=True).decode().strip()
    return taskIdResult.split('/')[-1]

taskId = get_task_id()

# Script to check accounts and the user's reset token
check_script = """
print('--- Checking Accounts ---');
var accountCount = db.accounts.countDocuments();
print('Total Accounts: ' + accountCount);
if (accountCount > 0) {
    print('Recent Accounts:');
    printjson(db.accounts.find().sort({createdAt: -1}).limit(3).toArray());
}

print('--- Checking User Reset Token ---');
var user = db.users.findOne({email: 'geoffrey.murray.1995@gmail.com'});
if (user) {
    print('User found. resetPasswordExpires type: ' + (user.resetPasswordExpires ? user.resetPasswordExpires.constructor.name : 'N/A'));
    printjson({
        email: user.email,
        resetPasswordExpires: user.resetPasswordExpires,
        role: user.role
    });
} else {
    print('User not found');
}
"""

args = [
    'aws', 'ecs', 'execute-command',
    '--cluster', cluster,
    '--task', taskId,
    '--container', 'mongodb',
    '--interactive',
    '--command', f'mongosh personal_web_app --eval "{check_script}"'
]

result = subprocess.run(args, capture_output=True, text=True)
print(result.stdout)
print(result.stderr)
