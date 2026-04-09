const { execSync } = require('child_process');
const cluster = 'artistic-hippopotamus-hw7oq2';
const service = 'personal-web-app-task-definition-service-4t236x8c';

const activeTaskDef = execSync('aws ecs describe-services --cluster ' + cluster + ' --services ' + service + ' --query "services[0].taskDefinition" --output text').toString().trim();
const allTaskArns = execSync('aws ecs list-tasks --cluster ' + cluster + ' --service-name ' + service + ' --desired-status RUNNING --query "taskArns" --output text').toString().trim();
const taskIdResult = execSync(`aws ecs describe-tasks --cluster ${cluster} --tasks ${allTaskArns.split(/\s+/).join(' ')} --query "tasks[?taskDefinitionArn=='${activeTaskDef}'].taskArn | [0]" --output text`).toString().trim();
const taskId = taskIdResult.split('/').pop();

console.log('TaskId:', taskId);

const jsonStr = JSON.stringify('geoffrey.murray.1995@gmail.com');
const hashString = JSON.stringify('$2b$10$BwP5Hzjz/CcZpy6x6rrtAOXBqY8IkwytTBhtHnJWbiUNSmjrfZTQq');

const evalScript = `
  var lead = db.leads.findOne({email: ${jsonStr}});
  if (lead) {
      db.users.insertOne({
          name: lead.firstName + ' ' + lead.lastName,
          email: lead.email,
          password: ${hashString},
          role: 'admin',
          isVerified: true
      });
      db.leads.deleteOne({_id: lead._id});
      print('Converted ' + ${jsonStr} + ' from Lead to User with new password.');
  } else {
      var user = db.users.findOne({email: ${jsonStr}});
      if (user) {
          db.users.updateOne(
              {_id: user._id},
              {$set: {role: 'admin', password: ${hashString}}}
          );
          print('User ' + ${jsonStr} + ' already exists. Updated role to admin and reset password.');
      } else {
          print('Lead/User ' + ${jsonStr} + ' not found!');
      }
  }
`;

try {
   const command = `aws ecs execute-command --cluster ${cluster} --task ${taskId} --container mongodb --interactive --command "mongosh personal_web_app --eval \\\"${evalScript.replace(/"/g, '\\"').replace(/\$/g, '\\$')}\\\""`;
   console.log("Running command:", command);
   const output = execSync(command, {stdio: 'pipe'}).toString();
   console.log('Output:', output);
} catch(e) {
   console.error('Error running eval:', e.stdout ? e.stdout.toString() : '', e.stderr ? e.stderr.toString() : e);
}
