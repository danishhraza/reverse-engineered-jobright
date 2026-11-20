import { probe } from '../src/content/autopilot';
import { scanFields } from '../src/engine/fields';

// Trakstar Hire (recruiterbox) job pages: the application form is already in the
// page but hidden until you press Apply. Its file inputs must not make the
// description page look like the form.

beforeEach(() => {
  document.body.innerHTML = `
    <div class="job-header">
      <div class="js-job-title">Software Engineer, PowerClerk</div>
      <button class="btn btn-link apply-with-linkedin hide" style="display:none">Apply with Linkedin</button>
      <button class="btn btn-link apply-with-indeed">Apply with Indeed</button>
      <a href="?apply=true" class="btn btn-primary btn-lg btn-apply js-apply-for-job">Apply</a>
    </div>
    <div class="jobdesciption"><h3>Who Are We?</h3><p>We build cloud software for utilities.</p></div>
    <div id="application" style="display:none">
      <form id="application_form" method="post">
        <div class="form-group"><label for="id_candidate_first_name">First name</label><input type="text" name="candidate_first_name" required id="id_candidate_first_name"></div>
        <div class="form-group"><label for="id_candidate_email">Email</label><input type="text" name="candidate_email" required id="id_candidate_email"></div>
        <div class="form-group"><label for="id_resume">Resume</label><input type="file" name="resume" class="form-control" required id="id_resume"></div>
        <div class="form-group"><label for="id_cover_letter">Cover Letter</label><input type="file" name="cover_letter" class="form-control" required id="id_cover_letter"></div>
        <input id="input_application_form_submit" class="btn btn-primary btn-lg" type="submit" value="Submit Application">
      </form>
    </div>`;
});

describe('Trakstar job page with the form hidden until Apply', () => {
  it('sees no fields in the hidden form, not even its file inputs', () => {
    expect(scanFields()).toEqual([]);
  });

  it('presses Apply (not "Apply with Indeed") first', () => {
    expect(probe()).toMatchObject({ kind: 'apply', detail: 'Apply' });
  });

  it('once Apply shows the form, its fields (and resume box) are there', () => {
    document.getElementById('application')!.style.display = '';
    expect(scanFields().map((f) => f.kind)).toEqual(['text', 'text', 'file', 'file']);
    expect(probe().kind).toBe('form');
  });

  it('still finds a resume input hidden behind an Attach button', () => {
    document.body.innerHTML = `<form><div class="field"><label>Resume</label>
      <div class="upload"><button type="button">Attach</button><span style="display:none"><input type="file" id="cv"></span></div></div></form>`;
    expect(scanFields().map((f) => f.kind)).toEqual(['file']);
  });
});
