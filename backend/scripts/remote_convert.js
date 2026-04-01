import { execSync } from 'child_process';

const cluster = "artistic-hippopotamus-hw7oq2";
const taskId = "4319228163ab4240b65adbd960bace23";
const targetEmail = "geoffrey.murray.1995@gmail.com";

const mongoshScript = `
use personal_web_app
var myLead = db.leads.findOne({ email: '${targetEmail}', status: 'New' })
if (myLead) {
    print('FOUND LEAD: ' + myLead.email);
    var userData = {
        name: myLead.firstName + ' ' + myLead.lastName,
        email: myLead.email,
        phone: myLead.phone,
        password: myLead.password,
        role: 'admin',
        isVerified: true,
        userNumber: 'ADM-' + Date.now(),
        createdAt: new Date(),
        updatedAt: new Date()
    };
    var result = db.users.insertOne(userData);
    if (result.insertedId) {
        db.leads.updateOne({ _id: myLead._id }, { $set: { status: 'Converted' } });
        print('SUCCESS: Converted Lead to User ' + result.insertedId);
    }
} else {
    print('ERROR: No New Lead found for ${targetEmail}');
    // Check if it already exists as Converted
    var convertedLead = db.leads.findOne({ email: '${targetEmail}', status: 'Converted' });
    if (convertedLead) {
        print('INFO: Lead already exists with status Converted');
    }
}
`.trim().replace(/\n/g, ' ');

const command = `aws ecs execute-command --cluster ${cluster} --task ${taskId} --container mongodb --interactive --command "mongosh personal_web_app --quiet --eval '${mongoshScript}'" --region us-east-2`;

try {
    console.log("Running command...");
    const output = execSync(command).toString();
    console.log("Output:");
    console.log(output);
} catch (err) {
    console.error("Command failed:");
    console.error(err.stdout?.toString());
    console.error(err.stderr?.toString());
}
