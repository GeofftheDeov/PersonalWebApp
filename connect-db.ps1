$ErrorActionPreference = "Stop"
$env:AWS_PAGER=""
$env:PATH += ";C:\Program Files\Amazon\SessionManagerPlugin\bin\"
$cluster = "artistic-hippopotamus-hw7oq2"
$service = "personal-web-app-task-definition-service-4t236x8c"

Write-Host "Fetching the active ECS task ID for the MongoDB container..."

# Try to get the running task that matches the primary task definition
$activeTaskDef = aws ecs describe-services --cluster $cluster --services $service --query "services[0].taskDefinition" --output text

$allTaskArns = aws ecs list-tasks --cluster $cluster --service-name $service --desired-status RUNNING --query "taskArns" --output text
if ([string]::IsNullOrWhiteSpace($allTaskArns) -or $allTaskArns -eq "None") {
    Write-Host "No running tasks found yet. The new deployment might still be initializing. Please try again in a minute." -ForegroundColor Yellow
    exit 1
}

$taskArn = aws ecs describe-tasks --cluster $cluster --tasks ($allTaskArns -split '\s+') --query "tasks[?taskDefinitionArn=='$activeTaskDef'].taskArn | [0]" --output text

if ([string]::IsNullOrWhiteSpace($taskArn) -or $taskArn -eq "None") {
    Write-Host "No running tasks found yet. The new deployment might still be initializing. Please try again in a minute." -ForegroundColor Yellow
    exit 1
}

$taskId = $taskArn.Split("/")[-1]
Write-Host "Connecting to task: $taskId" -ForegroundColor Green
Write-Host "Note: It may take up to 2-3 minutes from the time of deployment for the SSM agent to become fully ready." -ForegroundColor Yellow
Write-Host "Running execute-command..."

aws ecs execute-command --cluster $cluster --task $taskId --container mongodb --interactive --command "mongosh personal_web_app"
